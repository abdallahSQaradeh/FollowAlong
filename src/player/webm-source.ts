/**
 * Plays a WebM Lesson through MediaSource Extensions. VS Code's own ffmpeg has no WebM demuxer,
 * so `<video src="….webm">` fails, while Chromium's MSE parser plays VP8 + Vorbis with sound
 * (research 01). The file is streamed in and appended as it arrives; when the source buffer is
 * full, played-through media more than {@link keepBehindSeconds} behind the playhead is dropped.
 */

/** Every WebM Lesson measured in research 01 is VP8 + Vorbis. */
const webmType = 'video/webm; codecs="vp8, vorbis"';
/** How much already-played media stays buffered for a short step back. */
const keepBehindSeconds = 30;
/** Network chunks are gathered into appends of about this size. */
const appendBytes = 1024 * 1024;

function once(target: EventTarget, type: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      target.removeEventListener(type, onEvent);
      reject(signal.reason as Error);
    };
    const onEvent = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    target.addEventListener(type, onEvent, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

async function makeRoom(
  video: HTMLVideoElement,
  buffer: SourceBuffer,
  signal: AbortSignal,
): Promise<void> {
  const keepFrom = video.currentTime - keepBehindSeconds;
  const start = buffer.buffered.length > 0 ? buffer.buffered.start(0) : keepFrom;
  if (start < keepFrom) {
    buffer.remove(start, keepFrom);
    await once(buffer, 'updateend', signal);
  } else {
    // Nothing played-through to drop yet: wait until the playhead moves on.
    await once(video, 'timeupdate', signal);
  }
}

async function append(
  video: HTMLVideoElement,
  buffer: SourceBuffer,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    try {
      buffer.appendBuffer(bytes);
      await once(buffer, 'updateend', signal);
      return;
    } catch (error) {
      if (!isQuotaExceeded(error)) {
        throw error;
      }
      await makeRoom(video, buffer, signal);
    }
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Attaches a MediaSource for `uri` to `video` and streams the file into it. Resolves once the
 * whole file is appended; rejects on failure, or with the abort reason when `signal` aborts.
 */
export async function playWebm(
  video: HTMLVideoElement,
  uri: string,
  signal: AbortSignal,
): Promise<void> {
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  try {
    await once(mediaSource, 'sourceopen', signal);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  const buffer = mediaSource.addSourceBuffer(webmType);
  const response = await fetch(uri, { signal });
  if (!response.ok || response.body === null) {
    throw new Error(`could not read the video (HTTP ${String(response.status)})`);
  }
  const reader = response.body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) {
      pending.push(value);
      pendingBytes += value.byteLength;
    }
    if (pendingBytes > 0 && (done || pendingBytes >= appendBytes)) {
      await append(video, buffer, concat(pending, pendingBytes), signal);
      pending = [];
      pendingBytes = 0;
    }
    if (done) {
      break;
    }
  }
  if (mediaSource.readyState === 'open') {
    mediaSource.endOfStream();
  }
}
