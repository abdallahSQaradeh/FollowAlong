/**
 * The player: the script of the webview page (spec #12, Player). It plays what the extension
 * loads and reports what the media element does, through the typed message protocol only.
 */
import {
  parsePlayerCommand,
  type PlayerCommand,
  type PlayerEvent,
} from '../protocol/player-messages.js';
import { playWebm } from './webm-source.js';

declare global {
  /** Provided by VS Code inside a webview (and by the Seam 2 harness in Playwright). */
  function acquireVsCodeApi(): { postMessage(message: unknown): void };
}

const host = acquireVsCodeApi();
const video = document.querySelector('video');
if (video === null) {
  throw new Error('The player page has no <video> element.');
}

function post(event: PlayerEvent): void {
  host.postMessage(event);
}

/** The Lesson in the media element, and how to stop streaming it. */
let current: { readonly lessonId: string; readonly stop: AbortController } | undefined;
/** Set while a `pause` command is being carried out, so its pause is not reported as the learner's. */
let pauseRequested = false;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function load(command: Extract<PlayerCommand, { type: 'load' }>, media: HTMLVideoElement): void {
  current?.stop.abort();
  const stop = new AbortController();
  const lesson = { lessonId: command.lessonId, stop };
  current = lesson;
  playWebm(media, command.videoUri, stop.signal).catch((error: unknown) => {
    if (!stop.signal.aborted) {
      post({ type: 'error', lessonId: lesson.lessonId, message: describe(error) });
    }
  });
  if (command.startAt > 0) {
    media.addEventListener(
      'loadedmetadata',
      () => {
        media.currentTime = command.startAt;
      },
      { once: true, signal: stop.signal },
    );
  }
  if (command.autoplay) {
    play(media);
  }
}

function play(media: HTMLVideoElement): void {
  media.play().catch((error: unknown) => {
    // A new load interrupts a pending play() (AbortError): nothing to report then. Otherwise
    // (autoplay refused, say) the Lesson simply stays paused, as the extension is told.
    if (current !== undefined && !(error instanceof DOMException && error.name === 'AbortError')) {
      post({ type: 'paused', lessonId: current.lessonId, byUser: false });
    }
  });
}

function run(command: PlayerCommand, media: HTMLVideoElement): void {
  switch (command.type) {
    case 'load':
      load(command, media);
      break;
    case 'play':
      play(media);
      break;
    case 'pause':
      if (!media.paused) {
        pauseRequested = true;
        media.pause();
      }
      break;
  }
}

/** Forwards what the media element does to the extension, as protocol events. */
function reportMediaEvents(media: HTMLVideoElement): void {
  const lessonId = () => current?.lessonId;
  const on = (type: keyof HTMLMediaElementEventMap, handler: (id: string) => void) => {
    media.addEventListener(type, () => {
      const id = lessonId();
      if (id !== undefined) {
        handler(id);
      }
    });
  };
  on('timeupdate', (id) => {
    // A MediaSource stream reports NaN or Infinity until the end of the stream is known.
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    post({ type: 'timeUpdate', lessonId: id, position: media.currentTime, duration });
  });
  on('play', (id) => {
    post({ type: 'played', lessonId: id });
  });
  on('pause', (id) => {
    post({ type: 'paused', lessonId: id, byUser: !pauseRequested && !media.ended });
    pauseRequested = false;
  });
  on('ended', (id) => {
    post({ type: 'ended', lessonId: id });
  });
  on('error', (id) => {
    post({ type: 'error', lessonId: id, message: media.error?.message ?? 'the video failed' });
  });
}

const aac = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
reportMediaEvents(video);
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const command = parsePlayerCommand(event.data);
  if (command !== undefined) {
    run(command, video);
  }
});
post({ type: 'ready', aacSupported: aac !== '' });
