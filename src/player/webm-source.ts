/**
 * Plays a WebM Lesson through MediaSource Extensions (ADR 0006). VS Code's own ffmpeg has no WebM
 * demuxer, so `<video src="….webm">` fails, while Chromium's MSE parser plays VP8 + Vorbis with
 * sound (research 01).
 *
 * The file is streamed in and appended as it arrives. When the source buffer is full (Chromium's
 * MediaSource quota is about 150 MB), media more than `keepBehindSeconds` behind the playhead is
 * dropped. A seek to a time no longer buffered, and already streamed past, re-streams from the
 * Cluster at or before it with a Range request; the Cluster offsets come from reading the file
 * while it streams (WebmIndex). A seek ahead of the stream just lets the stream run on to it.
 */
import { defaultTuning } from './tuning.js';
import { WebmIndex } from './webm-index.js';

/** Every WebM Lesson measured in research 01 is VP8 + Vorbis. */
const webmType = 'video/webm; codecs="vp8, vorbis"';

const tuning = { ...defaultTuning, ...(window.followalongPlayerTuning ?? {}) };

/** Resolves on the first of `types` fired at `target`; rejects when `signal` aborts. */
function once(
  target: EventTarget,
  types: string | readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const names = typeof types === 'string' ? [types] : types;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const done = new AbortController();
    const settle = (settleWith: () => void) => {
      done.abort();
      settleWith();
    };
    for (const name of names) {
      target.addEventListener(
        name,
        () => {
          settle(resolve);
        },
        { once: true, signal: done.signal },
      );
    }
    signal.addEventListener(
      'abort',
      () => {
        settle(() => {
          reject(signal.reason as Error);
        });
      },
      { once: true, signal: done.signal },
    );
  });
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

function rangesOf(buffered: TimeRanges): [number, number][] {
  return Array.from({ length: buffered.length }, (_, index) => [
    buffered.start(index),
    buffered.end(index),
  ]);
}

function isBuffered(buffered: TimeRanges, time: number): boolean {
  return rangesOf(buffered).some(([start, end]) => start <= time && time < end);
}

/** Plays one Lesson's WebM file in `video`. */
export class WebmSource {
  private readonly mediaSource = new MediaSource();
  private readonly index = new WebmIndex();
  private buffer: SourceBuffer | undefined;
  /** Stops everything for this Lesson. */
  private readonly lifetime = new AbortController();
  /** Stops the current stream (one Range request), when a seek starts another. */
  private stream = new AbortController();
  /** Whether a stream is still reading the file (it stops at the end, or on a re-stream). */
  private streaming = false;
  /** File offset up to which the running stream has appended (bytes after it are not buffered). */
  private appendedTo = 0;
  /** Re-streams run one after another; only the latest seek's matters. */
  private restreams: Promise<void> = Promise.resolve();
  private latestSeek = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly uri: string,
    /** Called once if the Lesson cannot be played; nothing else is reported after it. */
    private readonly onFailure: (message: string) => void,
  ) {}

  /** Attaches the MediaSource and streams the file from its start. */
  start(): void {
    const objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = objectUrl;
    const signal = this.lifetime.signal;
    this.video.addEventListener(
      'seeking',
      () => {
        this.onSeeking();
      },
      { signal },
    );
    once(this.mediaSource, 'sourceopen', signal)
      .then(() => {
        URL.revokeObjectURL(objectUrl);
        this.buffer = this.mediaSource.addSourceBuffer(webmType);
        return this.run(0);
      })
      .catch((error: unknown) => {
        this.fail(error);
      });
  }

  dispose(): void {
    this.lifetime.abort();
    this.stream.abort();
  }

  private fail(error: unknown): void {
    if (this.lifetime.signal.aborted) {
      return;
    }
    this.dispose();
    this.onFailure(error instanceof Error ? error.message : String(error));
  }

  private onSeeking(): void {
    const time = this.video.currentTime;
    const buffer = this.buffer;
    if (buffer === undefined || isBuffered(buffer.buffered, time)) {
      return;
    }
    const from = this.index.clusterAt(time);
    if (from === undefined) {
      return;
    }
    // The target's Cluster ends where the next one starts; until the stream has appended past
    // that, the target is ahead of the stream, which reaches it by itself (dropping what is
    // behind it when the buffer is full).
    const next = this.index.clusters.find((cluster) => cluster.offset > from.offset);
    const appended = next === undefined ? !this.streaming : next.offset <= this.appendedTo;
    if (this.streaming && !appended) {
      return;
    }
    // Behind the stream, and no longer buffered: stream again from that Cluster.
    this.latestSeek += 1;
    const seek = this.latestSeek;
    this.stream.abort();
    this.streaming = false;
    this.restreams = this.restreams
      .then(() => this.restream(from.offset, seek))
      .catch((error: unknown) => {
        this.fail(error);
      });
  }

  /** Drops what is buffered and streams again from the Cluster at `offset`. */
  private async restream(offset: number, seek: number): Promise<void> {
    const buffer = this.buffer;
    const init = this.index.init;
    const signal = this.lifetime.signal;
    const superseded = () => seek !== this.latestSeek;
    if (buffer === undefined || init === undefined || superseded()) {
      return;
    }
    await this.idle(buffer, signal);
    if (this.mediaSource.readyState === 'open') {
      buffer.abort();
    }
    const ranges = rangesOf(buffer.buffered);
    const end = ranges[ranges.length - 1]?.[1];
    if (end !== undefined) {
      buffer.remove(0, end);
      await once(buffer, 'updateend', signal);
    }
    if (superseded()) {
      return;
    }
    // MediaSource needs the init segment again before media from the middle of the file.
    buffer.appendBuffer(new Uint8Array(init));
    await once(buffer, 'updateend', signal);
    if (superseded()) {
      return;
    }
    this.index.restartAt(offset);
    // Not awaited: the next re-stream must not wait for this one to reach the end of the file.
    this.run(offset).catch((error: unknown) => {
      this.fail(error);
    });
  }

  /** Streams the file from byte `offset` (0, or a Cluster start) to its end. */
  private async run(offset: number): Promise<void> {
    const buffer = this.buffer;
    if (buffer === undefined) {
      return;
    }
    const controller = new AbortController();
    this.stream = controller;
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.streaming = true;
    this.appendedTo = offset;
    try {
      const response = await fetch(this.uri, {
        signal,
        headers: offset > 0 ? { Range: `bytes=${String(offset)}-` } : {},
      });
      if (!response.ok || response.body === null) {
        throw new Error(`could not read the video (HTTP ${String(response.status)})`);
      }
      // A server that ignores Range sends the whole file: pass over the bytes before `offset`.
      let skip = offset > 0 && response.status !== 206 ? offset : 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        let bytes = value;
        if (skip > 0) {
          const passed = Math.min(skip, bytes.length);
          skip -= passed;
          bytes = bytes.subarray(passed);
        }
        if (bytes.length > 0) {
          this.index.feed(bytes);
          for (let at = 0; at < bytes.length; at += tuning.appendBytes) {
            const piece = bytes.slice(at, at + tuning.appendBytes);
            await this.append(buffer, piece, signal);
            this.appendedTo += piece.length;
            this.landPendingSeek(buffer);
          }
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      throw error;
    } finally {
      if (this.stream === controller) {
        this.streaming = false;
      }
    }
    if (this.mediaSource.readyState === 'open') {
      await this.idle(buffer, signal);
      this.mediaSource.endOfStream();
    }
  }

  /**
   * After a re-stream, Chromium drops the first Vorbis packet, so sound starts a few ms after the
   * picture; a seek target inside that gap would never finish. Move it onto the media.
   */
  private landPendingSeek(buffer: SourceBuffer): void {
    const time = this.video.currentTime;
    if (!this.video.seeking || isBuffered(buffer.buffered, time)) {
      return;
    }
    const start = rangesOf(buffer.buffered).find(([from]) => from > time && from - time < 0.1)?.[0];
    if (start !== undefined) {
      this.video.currentTime = start;
    }
  }

  private async append(
    buffer: SourceBuffer,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      try {
        if (this.bufferedSeconds(buffer) >= tuning.quotaSeconds) {
          throw new DOMException('the test quota is full', 'QuotaExceededError');
        }
        buffer.appendBuffer(bytes);
        await once(buffer, 'updateend', signal);
        return;
      } catch (error) {
        if (!isQuotaExceeded(error)) {
          throw error;
        }
        await this.makeRoom(buffer, signal);
      }
    }
  }

  /** Drops media well behind the playhead, or waits for the playhead to move on. */
  /**
   * Frees room in a full buffer. While the Lesson plays, only media more than keepBehindSeconds
   * behind the playhead goes. While the playhead waits for media the stream has not reached yet
   * (a start position or a forward seek past it), nothing buffered can play before the target:
   * everything behind the playhead goes, then anything ahead of it, so the stream can always go
   * on appending toward the target instead of waiting for a playhead that cannot move.
   */
  private async makeRoom(buffer: SourceBuffer, signal: AbortSignal): Promise<void> {
    const time = this.video.currentTime;
    const ranges = rangesOf(buffer.buffered);
    const waiting = !isBuffered(buffer.buffered, time);
    const keepFrom = waiting ? time : time - tuning.keepBehindSeconds;
    const first = ranges[0];
    const ahead = waiting ? ranges.find(([start]) => start > time) : undefined;
    if (first !== undefined && first[0] < keepFrom) {
      buffer.remove(first[0], keepFrom);
      await once(buffer, 'updateend', signal);
    } else if (ahead !== undefined) {
      buffer.remove(ahead[0], ahead[1]);
      await once(buffer, 'updateend', signal);
    } else {
      // Wait for the playhead to move: by playing, or by a seek (a start position is applied
      // with a seek once the metadata is in, which may come after the buffer filled up).
      await once(this.video, ['timeupdate', 'seeking'], signal);
    }
  }

  private bufferedSeconds(buffer: SourceBuffer): number {
    return rangesOf(buffer.buffered).reduce((total, [start, end]) => total + end - start, 0);
  }

  private async idle(buffer: SourceBuffer, signal: AbortSignal): Promise<void> {
    while (buffer.updating) {
      await once(buffer, 'updateend', signal);
    }
  }
}
