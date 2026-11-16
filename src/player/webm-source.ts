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

/** The end of the seekable range of a WebM whose length is not known yet: seconds, far past any Lesson. */
const unknownLengthSeekableEnd = 24 * 60 * 60;

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
  /** File offset the running stream started at (0, or a Cluster start). */
  private streamFrom = 0;
  /** File offset up to which the running stream has appended (bytes after it are not buffered). */
  private appendedTo = 0;
  /**
   * File offset up to which the running stream has read the file into the index: `appendedTo`,
   * plus the piece being appended, which can wait for room a long time. A Cluster the index found
   * in that piece is on the stream's way.
   */
  private readTo = 0;
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
        this.declareSeekableRange(this.buffer);
        return this.run(0);
      })
      .catch((error: unknown) => {
        this.fail(error);
      });
  }

  /**
   * A WebM without a Duration element leaves the MediaSource duration unknown (Infinity) until the
   * stream ends, and then `seekable` stops at the buffered end: a seek further ahead, such as a
   * long forward step, would be silently cut short. Declaring the whole timeline seekable lets such
   * a seek go through `onSeeking` and wait for the stream like any other seek ahead of it. The
   * range ends with the stream (`endOfStream` fixes the duration).
   */
  private declareSeekableRange(buffer: SourceBuffer): void {
    buffer.addEventListener(
      'updateend',
      () => {
        if (this.mediaSource.readyState === 'open' && !Number.isFinite(this.mediaSource.duration)) {
          this.mediaSource.setLiveSeekableRange(0, unknownLengthSeekableEnd);
        }
      },
      { once: true, signal: this.lifetime.signal },
    );
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
    const buffer = this.buffer;
    if (buffer === undefined) {
      return;
    }
    // Every seek supersedes a re-stream that has not started yet.
    this.latestSeek += 1;
    const time = this.video.currentTime;
    if (isBuffered(buffer.buffered, time)) {
      return;
    }
    const offset = this.restreamOffset(time, buffer);
    if (offset === undefined) {
      return;
    }
    const seek = this.latestSeek;
    this.restreams = this.restreams
      .then(() => this.restream(offset, seek))
      .catch((error: unknown) => {
        this.fail(error);
      });
  }

  /** Where to stream from to reach `time`, or `undefined` when the running stream gets there. */
  private restreamOffset(time: number, buffer: SourceBuffer): number | undefined {
    if (this.index.broken) {
      // No Cluster offsets: only the start of the file is a known place to stream from. A target
      // behind what is buffered was dropped and needs it; one ahead is on the stream's way.
      const last = rangesOf(buffer.buffered).at(-1);
      return this.streaming && (last === undefined || time >= last[0]) ? undefined : 0;
    }
    const from = this.index.clusterAt(time) ?? this.index.clusters[0];
    if (from === undefined) {
      // Nothing indexed yet: the stream from the start of the file is still on its way.
      return this.streaming ? undefined : 0;
    }
    const next = this.index.clusterAfter(from);
    // The running stream has read the target's Cluster but not appended all of it: it appends
    // the target next. Otherwise the target is behind the stream (dropped) or in a Cluster known
    // from an earlier stream ahead of it, and a Range request from that Cluster gets there directly.
    const inside =
      this.streaming &&
      from.offset >= this.streamFrom &&
      from.offset <= this.readTo &&
      (next === undefined || next.offset > this.appendedTo);
    return inside ? undefined : from.offset;
  }

  /** Drops what is buffered and streams again from byte `offset` (0, or a Cluster start). */
  private async restream(offset: number, seek: number): Promise<void> {
    const buffer = this.buffer;
    const init = this.index.init;
    const signal = this.lifetime.signal;
    if (buffer === undefined || seek !== this.latestSeek || (offset > 0 && init === undefined)) {
      return;
    }
    // Committed from here on: the running stream stops and the buffer is replaced.
    this.stream.abort();
    this.streaming = false;
    await this.idle(buffer, signal);
    if (this.mediaSource.readyState === 'open') {
      buffer.abort();
    }
    const ranges = rangesOf(buffer.buffered);
    const end = ranges[ranges.length - 1]?.[1];
    if (end !== undefined) {
      await this.idle(buffer, signal);
      buffer.remove(0, end);
      await once(buffer, 'updateend', signal);
    }
    if (offset > 0 && init !== undefined) {
      // MediaSource needs the init segment again before media from the middle of the file.
      await this.idle(buffer, signal);
      buffer.appendBuffer(new Uint8Array(init));
      await once(buffer, 'updateend', signal);
    }
    this.index.restartAt(offset);
    // Not awaited: the next re-stream must not wait for this one to reach the end of the file.
    this.run(offset).catch((error: unknown) => {
      this.fail(error);
    });
    // A seek made while this one was being set up may need a re-stream of its own.
    this.onSeeking();
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
    this.streamFrom = offset;
    this.appendedTo = offset;
    this.readTo = offset;
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
          for (let at = 0; at < bytes.length; at += tuning.appendBytes) {
            const piece = bytes.slice(at, at + tuning.appendBytes);
            // The index only knows what is appended, so it never runs ahead of the buffer.
            this.index.feed(piece);
            this.readTo += piece.length;
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
        // Every buffer operation first waits for the previous one, whoever started it.
        await this.idle(buffer, signal);
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
   * behind the playhead goes, and never the group of pictures the playhead is in (see
   * `removableBefore`). While the playhead waits for media the stream has not reached yet
   * (a start position or a forward seek past it), nothing buffered can play before the target:
   * everything behind the playhead goes, then anything ahead of it, so the stream can always go
   * on appending toward the target instead of waiting for a playhead that cannot move.
   */
  private async makeRoom(buffer: SourceBuffer, signal: AbortSignal): Promise<void> {
    const time = this.video.currentTime;
    const ranges = rangesOf(buffer.buffered);
    const playing = rangesOf(buffer.buffered).find(([start, end]) => start <= time && time < end);
    // Waiting for media, or about to: less than a second left to play before the stream's next
    // append, which only fits once something goes.
    const waiting = playing === undefined || playing[1] - time < 1;
    const wanted = waiting ? time : time - tuning.keepBehindSeconds;
    // The group of pictures the playhead is on (or the stream is on its way to it in) stays.
    const keepFrom = Math.min(wanted, this.removableBefore(time));
    const first = ranges[0];
    const ahead = waiting ? ranges.find(([start]) => start > time) : undefined;
    if (first !== undefined && first[0] < keepFrom) {
      await this.idle(buffer, signal);
      buffer.remove(first[0], keepFrom);
      await once(buffer, 'updateend', signal);
    } else if (ahead !== undefined) {
      await this.idle(buffer, signal);
      buffer.remove(ahead[0], ahead[1]);
      await once(buffer, 'updateend', signal);
    } else {
      // Wait for the playhead to move: by playing, or by a seek (a start position is applied
      // with a seek once the metadata is in, which may come after the buffer filled up).
      await once(this.video, ['timeupdate', 'seeking'], signal);
    }
  }

  /**
   * The latest time a removal may end at and keep the frame at `time`, whether it is buffered or
   * the stream is still on its way to it. MediaSource also drops the video frames after a
   * removal's end, up to the next keyframe, so a removal ending inside the group of pictures at
   * `time` takes that frame with it. A Cluster starts at or just before a keyframe (re-streaming
   * relies on it too), but its timecode can belong to an audio block a few ms before the
   * keyframe: the keyframe before `time` may be in the Cluster before the one at `time`, so
   * removal stops at the start of that earlier Cluster. That keeps at most two Clusters behind
   * the playhead: room runs out only if two Clusters and a second fill the whole quota.
   */
  private removableBefore(time: number): number {
    const clusters = this.index.clusters;
    const at = this.index.clusterAt(time);
    // A broken index stops finding Clusters: the last one it found may be far behind `time`.
    if (at === undefined || this.index.broken) {
      return Number.POSITIVE_INFINITY;
    }
    return (clusters[clusters.indexOf(at) - 1] ?? at).time;
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
