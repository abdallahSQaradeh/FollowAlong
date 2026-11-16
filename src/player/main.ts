/**
 * The player: the script of the webview page (spec #12, Player). It plays what the extension
 * loads and reports what the media element does, through the typed message protocol only.
 */
import {
  parsePlayerCommand,
  type PlayerCommand,
  type PlayerEvent,
} from '../protocol/player-messages.js';
import { WebmSource } from './webm-source.js';

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

interface Lesson {
  readonly lessonId: string;
  /** Stops streaming this Lesson. */
  readonly stop: AbortController;
  /** Set once `error` was posted: nothing else is reported for this Lesson. */
  failed: boolean;
  /** Whether `played` was posted since the last pause, so a recovered stall is not a new play. */
  playing: boolean;
}

/** The Lesson in the media element. */
let current: Lesson | undefined;
/**
 * Who started the pause the media element is about to report: the extension (a `pause` command,
 * not the learner's) or a click on the picture (the learner's, already reported as an
 * interaction). Unset for a pause from the native control bar or the end of the Lesson.
 */
let pauseBy: 'extension' | 'picture' | undefined;
/** Set while the player's own `play()` starts the media element, so its `play` is not the control bar's. */
let playRequested = false;
/** Set while the learner drags a native slider (the seek bar or the volume). */
let dragging = false;

/** Reports the Lesson's one `error`, and silences it from then on. */
function fail(lesson: Lesson, message: string, media: HTMLVideoElement): void {
  if (lesson.failed || lesson !== current) {
    return;
  }
  lesson.failed = true;
  lesson.stop.abort();
  post({ type: 'error', lessonId: lesson.lessonId, message });
  media.pause();
}

function load(command: Extract<PlayerCommand, { type: 'load' }>, media: HTMLVideoElement): void {
  current?.stop.abort();
  // A pause or play whose event the new load cancels must not mark the next one.
  pauseBy = undefined;
  playRequested = false;
  const lesson: Lesson = {
    lessonId: command.lessonId,
    stop: new AbortController(),
    failed: false,
    playing: false,
  };
  current = lesson;
  const { signal } = lesson.stop;
  const source = new WebmSource(media, command.videoUri, (message) => {
    fail(lesson, message, media);
  });
  signal.addEventListener('abort', () => {
    source.dispose();
  });
  source.start();
  if (command.startAt > 0) {
    media.addEventListener(
      'loadedmetadata',
      () => {
        media.currentTime = command.startAt;
      },
      { once: true, signal },
    );
  }
  if (command.autoplay) {
    play(media);
  }
}

function play(media: HTMLVideoElement): void {
  const lesson = current;
  // A media element that is already playing fires no `play` event to clear the flag.
  playRequested = media.paused;
  media.play().catch((error: unknown) => {
    playRequested = false;
    // Autoplay refused: the Lesson stays paused, and the extension is told. Other rejections
    // come from a new load (AbortError) or a failed Lesson, which reports its own `error`.
    if (
      lesson !== undefined &&
      lesson === current &&
      !lesson.failed &&
      error instanceof DOMException &&
      error.name === 'NotAllowedError'
    ) {
      post({ type: 'paused', lessonId: lesson.lessonId, byUser: false });
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
        pauseBy = 'extension';
        media.pause();
      }
      break;
  }
}

/** Forwards what the media element does to the extension, as protocol events. */
function reportMediaEvents(media: HTMLVideoElement): void {
  /** Runs `handler` for the current Lesson, unless it has failed. */
  const on = (type: keyof HTMLMediaElementEventMap, handler: (lesson: Lesson) => void) => {
    media.addEventListener(type, () => {
      if (current !== undefined && !current.failed) {
        handler(current);
      }
    });
  };
  const reportTime = ({ lessonId }: Lesson) => {
    // A MediaSource stream reports NaN or Infinity until the end of the stream is known.
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    post({ type: 'timeUpdate', lessonId, position: media.currentTime, duration });
  };
  on('timeupdate', reportTime);
  // Also when the length becomes known, so the extension has it before the Lesson plays.
  on('durationchange', (lesson) => {
    if (Number.isFinite(media.duration) && media.duration > 0) {
      reportTime(lesson);
    }
  });
  // `playing`, not `play`: `play` fires before any media is ready, even for a file that fails.
  on('playing', (lesson) => {
    if (!lesson.playing) {
      lesson.playing = true;
      post({ type: 'played', lessonId: lesson.lessonId });
    }
  });
  on('pause', (lesson) => {
    lesson.playing = false;
    const fromControlBar = pauseBy === undefined && !media.ended;
    post({
      type: 'paused',
      lessonId: lesson.lessonId,
      byUser: pauseBy !== 'extension' && !media.ended,
    });
    pauseBy = undefined;
    if (fromControlBar) {
      interacted();
    }
  });
  on('play', () => {
    if (!playRequested) {
      interacted();
    }
    playRequested = false;
  });
  on('ended', (lesson) => {
    lesson.playing = false;
    post({ type: 'ended', lessonId: lesson.lessonId });
  });
  on('error', (lesson) => {
    fail(lesson, media.error?.message ?? 'the video failed', media);
  });
}

/** Tells the extension the learner is done with the player, so it hands focus back (ADR 0007). */
function interacted(): void {
  if (!dragging) {
    post({ type: 'userInteracted' });
  }
}

/** A click on the picture plays or pauses the Lesson. */
function togglePlayback(media: HTMLVideoElement): void {
  if (current === undefined || current.failed) {
    return;
  }
  if (media.paused) {
    play(media);
  } else {
    pauseBy = 'picture';
    media.pause();
  }
}

/**
 * Reports the end of each learner interaction as `userInteracted`. The native control bar keeps
 * its pointer events to itself, so its buttons show only through what they change, and its
 * sliders through their pointer capture, which ends when the learner lets go.
 */
function reportInteractions(media: HTMLVideoElement, overlay: Element): void {
  overlay.addEventListener('click', () => {
    togglePlayback(media);
  });
  // A click on the picture, or on the video under a hidden control bar.
  window.addEventListener('pointerup', interacted);
  media.addEventListener('gotpointercapture', () => {
    dragging = true;
  });
  media.addEventListener('lostpointercapture', () => {
    dragging = false;
    interacted();
  });
  // The mute button; the volume slider reports on release, as above.
  media.addEventListener('volumechange', interacted);
}

const overlay = document.querySelector('.overlay');
if (overlay === null) {
  throw new Error('The player page has no overlay.');
}
const aac = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
reportMediaEvents(video);
reportInteractions(video, overlay);
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const command = parsePlayerCommand(event.data);
  if (command !== undefined) {
    run(command, video);
  }
});
post({ type: 'ready', aacSupported: aac !== '' });
