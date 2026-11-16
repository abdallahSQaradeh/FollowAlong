/**
 * The player: the script of the webview page (spec #12, Player). It plays what the extension
 * loads and reports what the media element does, through the typed message protocol only.
 */
import {
  parsePlayerCommand,
  type AboutLesson,
  type PlayerCommand,
  type PlayerEvent,
} from '../protocol/player-messages.js';
import { Interactions } from './interactions.js';
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
const nextButton = document.querySelector<HTMLElement>('.next');
if (nextButton === null) {
  throw new Error('The player page has no Next overlay.');
}
/** The "Next: <title>" overlay over the picture of a Lesson that has ended (ADR 0019). */
const nextOverlay: HTMLElement = nextButton;

function post(event: PlayerEvent): void {
  host.postMessage(event);
}

/** Keys held down in the player page: a held key is an interaction that has not ended. */
const keysDown = new Set<string>();
/** Set when an interaction ended while the player was fullscreen: it is reported on exit. */
let reportAfterFullscreen = false;

/** Tells the extension the learner is done with the player, so it hands focus back. */
function handFocusBack(): void {
  post({ type: 'userInteracted' });
  // Let go of the focus, so the next click on the native control bar focuses the video again:
  // that `focus` is all the page sees of a click on an empty part of the bar.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

const interactions = new Interactions(
  () => {
    // Fullscreen covers the code: focus stays with the video, so Space still plays or pauses it
    // rather than typing into hidden code. The interaction is reported once fullscreen ends.
    if (document.fullscreenElement !== null) {
      reportAfterFullscreen = true;
      return;
    }
    handFocusBack();
  },
  // A press shows as `:active` on the video, also on its native control bar, until it is let go.
  () => video.matches(':active') || keysDown.size > 0,
);
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === null && reportAfterFullscreen) {
    reportAfterFullscreen = false;
    handFocusBack();
  }
});

interface Lesson {
  /** What every event about this Lesson carries: its id and the `loadId` of its `load`. */
  readonly about: AboutLesson;
  /** Stops streaming this Lesson. */
  readonly stop: AbortController;
  /** Set once `error` was posted: nothing else is reported for this Lesson. */
  failed: boolean;
  /** Whether `played` was posted since the last pause, so a recovered stall is not a new play. */
  playing: boolean;
  /** Where the `load`'s `startAt` seek goes, until a seek lands; `undefined` once none is pending. */
  startTarget: number | undefined;
  /** Whether the seek under way is the one that applies `startTarget`. */
  seekingToStart: boolean;
}

/**
 * How far a seek's target may be from `startAt` and still be the seek that applies it: the WebM
 * stream moves a seek onto buffered media less than 0.1 s away (ADR 0006).
 */
const startSeekToleranceSeconds = 0.5;

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
/** The playback rate last reported, so a `ratechange` that changes nothing is not. */
let reportedRate = 1;
/** The seconds a click that resumes a paused Lesson steps back first (Rewind, ADR 0016). */
let resumeRewind = 0;

/** Reports the Lesson's one `error`, and silences it from then on. */
function fail(lesson: Lesson, message: string, media: HTMLVideoElement): void {
  if (lesson.failed || lesson !== current) {
    return;
  }
  lesson.failed = true;
  lesson.stop.abort();
  post({ type: 'error', ...lesson.about, message });
  media.pause();
}

function load(command: Extract<PlayerCommand, { type: 'load' }>, media: HTMLVideoElement): void {
  current?.stop.abort();
  hideNext();
  // A pause or play whose event the new load cancels must not mark the next one.
  pauseBy = undefined;
  playRequested = false;
  const lesson: Lesson = {
    about: {
      lessonId: command.lessonId,
      ...(command.loadId === undefined ? {} : { loadId: command.loadId }),
    },
    stop: new AbortController(),
    failed: false,
    playing: false,
    startTarget: command.startAt > 0 ? command.startAt : undefined,
    seekingToStart: false,
  };
  current = lesson;
  const { signal } = lesson.stop;
  if (command.container === 'webm') {
    // `<video src>` cannot play WebM in VS Code, so it is streamed through MediaSource.
    const source = new WebmSource(media, command.videoUri, (message) => {
      fail(lesson, message, media);
    });
    signal.addEventListener('abort', () => {
      source.dispose();
    });
    source.start();
  } else {
    // The picture plays straight from the file; its sound is a later ticket's sidecar.
    media.src = command.videoUri;
  }
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
      post({ type: 'paused', ...lesson.about, byUser: false });
    }
  });
}

/**
 * Moves the playhead by `seconds`, stopping at the start and at the end of the Lesson. Setting
 * `currentTime` is what the native seek bar does too, so a WebM seek into media the buffer
 * dropped takes the re-stream path (ADR 0006). While a seek is under way `currentTime` is
 * already its target, so steps pressed in a row add up.
 */
function seekBy(seconds: number, media: HTMLVideoElement): void {
  const end = Number.isFinite(media.duration) ? media.duration : Number.POSITIVE_INFINITY;
  media.currentTime = Math.min(Math.max(media.currentTime + seconds, 0), end);
}

/**
 * Sets the playback rate. The default rate is set too, because a new `src` (the next Lesson)
 * resets the playback rate to it, and the rate is meant to stay from Lesson to Lesson.
 */
function setRate(rate: number, media: HTMLVideoElement): void {
  media.defaultPlaybackRate = rate;
  media.playbackRate = rate;
}

function hideNext(): void {
  nextOverlay.setAttribute('hidden', '');
}

/**
 * Shows the overlay, but only over a Lesson that is still at its end: the extension answers
 * `ended` asynchronously, and a learner who has pressed play or loaded another Lesson since
 * must not find it over a playing picture.
 */
function showNext(title: string, media: HTMLVideoElement): void {
  if (!media.ended) {
    return;
  }
  nextOverlay.textContent = `Next: ${title}`;
  nextOverlay.removeAttribute('hidden');
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
    case 'seekBy':
      seekBy(command.seconds, media);
      break;
    case 'setRate':
      setRate(command.rate, media);
      break;
    case 'showNext':
      showNext(command.title, media);
      break;
    case 'setResumeRewind':
      resumeRewind = command.seconds;
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
  const reportTime = ({ about }: Lesson) => {
    // A MediaSource stream reports NaN or Infinity until the end of the stream is known.
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    post({ type: 'timeUpdate', ...about, position: media.currentTime, duration });
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
      post({ type: 'played', ...lesson.about });
    }
  });
  on('pause', (lesson) => {
    lesson.playing = false;
    const byUser = pauseBy !== 'extension' && !media.ended;
    // The learner's, and not already reported by the click on the picture that asked for it.
    const byControlBar = byUser && pauseBy !== 'picture';
    post({ type: 'paused', ...lesson.about, byUser });
    pauseBy = undefined;
    if (byControlBar) {
      interactions.ended();
    }
  });
  on('play', () => {
    if (!playRequested) {
      interactions.ended();
    }
    playRequested = false;
  });
  // The learner plays the Lesson again, or steps back into it: it is not at its end any more.
  // Not through `on`: a Lesson that failed must lose the overlay too.
  media.addEventListener('playing', hideNext);
  media.addEventListener('seeking', hideNext);
  // `currentTime` is the target of a seek while it is under way, wherever it lands. A seek to the
  // start position is FollowAlong's own; any other, such as the learner's on the seek bar while the
  // start seek is still pending (the browser drops that one for theirs), is not. The last wins.
  on('seeking', (lesson) => {
    lesson.seekingToStart =
      lesson.startTarget !== undefined &&
      Math.abs(media.currentTime - lesson.startTarget) <= startSeekToleranceSeconds;
  });
  on('seeked', (lesson) => {
    post({ type: 'seeked', ...lesson.about, startSeek: lesson.seekingToStart });
    // A seek has landed: the start seek is over, or was dropped for another.
    lesson.startTarget = undefined;
    lesson.seekingToStart = false;
  });
  // Every change is reported, whoever made it, so the extension never drifts. The video's own
  // speed menu is hidden (`noplaybackrate`, ADR 0009), so today only `setRate` changes it.
  // `ratechange` also fires for a change of `defaultPlaybackRate`, which `setRate` makes too, and
  // it is tracked even when nothing can be reported (no Lesson, or a failed one).
  media.addEventListener('ratechange', () => {
    if (media.playbackRate === reportedRate) {
      return;
    }
    reportedRate = media.playbackRate;
    if (current !== undefined && !current.failed) {
      post({ type: 'rateChanged', ...current.about, rate: reportedRate });
    }
  });
  on('ended', (lesson) => {
    lesson.playing = false;
    post({ type: 'ended', ...lesson.about });
  });
  on('error', (lesson) => {
    fail(lesson, media.error?.message ?? 'the video failed', media);
  });
}

/** A click on the picture plays or pauses the Lesson. */
function togglePlayback(media: HTMLVideoElement): void {
  if (current === undefined || current.failed) {
    return;
  }
  if (media.paused) {
    // A Lesson that ended starts again from the top, so there is nothing to rehear.
    // At the very start there is nothing to step back to; a seek to 0 would still report `seeked`.
    if (resumeRewind > 0 && !media.ended && media.currentTime > 0) {
      seekBy(-resumeRewind, media);
    }
    play(media);
  } else {
    pauseBy = 'picture';
    media.pause();
  }
}

/**
 * Reports the end of each learner interaction as `userInteracted` (ADR 0009). The native control
 * bar keeps its pointer events to itself, so its buttons show only through what they change, and
 * its sliders through their pointer capture, which ends when the learner lets go.
 */
function reportInteractions(media: HTMLVideoElement, overlay: Element): void {
  const ended = () => {
    interactions.ended();
  };
  overlay.addEventListener('click', () => {
    togglePlayback(media);
  });
  // The overlay takes the pointer moves that would show the native control bar: pass them on.
  overlay.addEventListener('pointermove', (event) => {
    const { clientX, clientY, pointerId, pointerType } = event as PointerEvent;
    media.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX, clientY, pointerId, pointerType }),
    );
  });
  // A click on the picture, or on the video under a hidden control bar.
  window.addEventListener('pointerup', ended);
  // A key on the native controls, after the learner tabbed to them: reported when let go.
  window.addEventListener(
    'keydown',
    (event) => {
      keysDown.add(event.code);
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (event) => {
      keysDown.delete(event.code);
      ended();
    },
    true,
  );
  // A key let go outside the page (focus moved away mid-press) never sends its keyup.
  window.addEventListener('blur', () => {
    keysDown.clear();
  });
  media.addEventListener('gotpointercapture', (event) => {
    interactions.beginGesture(event.pointerId);
  });
  media.addEventListener('lostpointercapture', (event) => {
    interactions.endGesture(event.pointerId);
  });
  // A click on the native control bar, including an empty part of it, focuses the video.
  media.addEventListener('focus', () => {
    interactions.focused();
  });
  // The mute button; the volume slider reports on release, as above.
  media.addEventListener('volumechange', ended);
}

const overlay = document.querySelector('.overlay');
if (overlay === null) {
  throw new Error('The player page has no overlay.');
}

nextOverlay.addEventListener('click', () => {
  if (current !== undefined && !current.failed) {
    post({ type: 'nextClicked', ...current.about });
  }
});
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
