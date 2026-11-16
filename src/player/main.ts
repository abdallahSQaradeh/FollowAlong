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
const soundElement = document.querySelector('audio');
if (soundElement === null) {
  throw new Error('The player page has no <audio> element.');
}
/**
 * The hidden `<audio>` that plays an MP4 Lesson's sound, converted to MP3, beside the video when
 * the page cannot decode AAC (the audio sidecar, ADR 0034). The video is the clock: the sound
 * follows its play, pause, seeks, rate, volume and mute.
 */
const sidecar: HTMLAudioElement = soundElement;
/**
 * Whether the page decodes AAC, the sound of every MP4 Lesson; VS Code does not. The one check
 * behind both `ready {aacSupported}` and the sidecar: a page that can play the video's own sound
 * never plays a sidecar, so the sound never plays twice (ADR 0034).
 */
const aacSupported = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== '';
/** How far the sidecar may drift from the video before it is moved back to it, in seconds. */
const maxDriftSeconds = 0.1;

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
  /**
   * Where the Lesson's sound comes from: its own track (`own`); the sidecar, still to come
   * (`awaited`) or playing beside the video (`sidecar`); or none, because it could not be
   * prepared (`none`).
   */
  sound: 'own' | 'awaited' | 'sidecar' | 'none';
  /** Set while the sound is awaited: the Lesson plays as soon as it arrives (autoplay, or a press). */
  playWhenSound: boolean;
  /** The last `currentTime` the player wrote itself, until a seek lands. */
  lastWrite: { readonly time: number; readonly origin: SeekOrigin } | undefined;
  /**
   * Whether the seek under way began with the seek that applies the `load`'s `startAt` and since
   * then only the player's own writes touched it: a seek bar seek or a step makes it false.
   */
  startChain: boolean;
}

/** Why the player writes `currentTime`: the start position, a step, or moving a seek onto media. */
type SeekOrigin = 'start' | 'step' | 'adjust';

/** How far a seek's target may be from what the player wrote and still be that write. */
const ownWriteEpsilonSeconds = 0.001;

/**
 * Every `currentTime` the player writes goes through here, so `seeking` can tell its own seeks from
 * the learner's (the seek bar writes `currentTime` natively): the media element reports the target
 * of a seek in `currentTime` while it is under way.
 */
function writeTime(
  lesson: Lesson | undefined,
  media: HTMLVideoElement,
  time: number,
  origin: SeekOrigin,
): void {
  if (lesson !== undefined) {
    lesson.lastWrite = { time, origin };
  }
  media.currentTime = time;
}

/** Whether the seek that just began is the one the player wrote last (a browser clamps to the end). */
function isOwnSeek(lesson: Lesson, media: HTMLVideoElement): boolean {
  const written = lesson.lastWrite?.time;
  if (written === undefined) {
    return false;
  }
  const target = media.currentTime;
  const clamped = Number.isFinite(media.duration) && written > media.duration;
  return Math.abs(target - (clamped ? media.duration : written)) <= ownWriteEpsilonSeconds;
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

/** Stops the sidecar of the Lesson before and empties it, so it never plays over the next one. */
function dropSound(): void {
  sidecar.pause();
  if (sidecar.hasAttribute('src')) {
    sidecar.removeAttribute('src');
    sidecar.load();
  }
}

function load(command: Extract<PlayerCommand, { type: 'load' }>, media: HTMLVideoElement): void {
  current?.stop.abort();
  hideNext();
  dropSound();
  // An MP4 whose AAC sound the page cannot decode waits for its sound. The native controls are
  // hidden meanwhile: their play button would start the picture without its sound. The video is
  // not muted: its own sound is one the page cannot play, and its volume and mute stay the
  // learner's controls, which the sidecar follows.
  const awaitsSound = command.container === 'mp4' && !aacSupported;
  media.controls = !awaitsSound;
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
    sound: awaitsSound ? 'awaited' : 'own',
    playWhenSound: false,
    lastWrite: undefined,
    startChain: false,
  };
  current = lesson;
  const { signal } = lesson.stop;
  if (command.container === 'webm') {
    // `<video src>` cannot play WebM in VS Code, so it is streamed through MediaSource.
    const source = new WebmSource(
      media,
      command.videoUri,
      (message) => {
        fail(lesson, message, media);
      },
      (time) => {
        writeTime(lesson, media, time, 'adjust');
      },
    );
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
        writeTime(lesson, media, command.startAt, 'start');
      },
      { once: true, signal },
    );
  }
  if (command.autoplay) {
    play(media);
  }
}

/** Moves the sidecar to the video's playhead and rate. */
function alignSound(media: HTMLVideoElement): void {
  sidecar.defaultPlaybackRate = media.playbackRate;
  sidecar.playbackRate = media.playbackRate;
  if (Math.abs(sidecar.currentTime - media.currentTime) > maxDriftSeconds) {
    sidecar.currentTime = media.currentTime;
  }
}

/**
 * The wait for the Lesson's sound is over: it arrived (`audioUri`), and plays beside the video
 * from now on, or it could not be prepared, and the Lesson plays without sound (ticket #42
 * replaces that with an overlay and a "Play without sound" button). A play asked for meanwhile
 * goes ahead.
 */
function soundSettled(audioUri: string | undefined, media: HTMLVideoElement): void {
  const lesson = current;
  if (lesson?.sound !== 'awaited') {
    return;
  }
  if (audioUri === undefined) {
    lesson.sound = 'none';
  } else {
    lesson.sound = 'sidecar';
    sidecar.src = audioUri;
    alignSound(media);
  }
  media.controls = true;
  if (lesson.playWhenSound) {
    play(media);
  }
}

/** Starts the sidecar at the video's playhead and rate. */
function startSound(media: HTMLVideoElement): Promise<void> {
  alignSound(media);
  return sidecar.play();
}

/** Starts the video, and its sidecar first when it has one. */
function play(media: HTMLVideoElement): void {
  const lesson = current;
  if (lesson?.sound === 'awaited') {
    // Plays once the sound arrives (spec #12, story 70).
    lesson.playWhenSound = true;
    return;
  }
  if (lesson?.sound === 'sidecar' && media.paused) {
    // The sound first: VS Code refuses sound until the learner has clicked in the page (#12 D3),
    // so the picture never starts where its sound cannot.
    startSound(media).then(
      () => {
        // A pause or another Lesson since then (a pause stops the sidecar again).
        if (lesson === current && !sidecar.paused) {
          playVideo(media);
        }
      },
      (error: unknown) => {
        if (lesson === current && !lesson.failed && isRefusal(error)) {
          post({ type: 'paused', ...lesson.about, byUser: false });
        }
      },
    );
    return;
  }
  playVideo(media);
}

/** Whether `play()` was refused because the learner has not acted in the page yet (#12 D3). */
function isRefusal(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}

function playVideo(media: HTMLVideoElement): void {
  const lesson = current;
  // A media element that is already playing fires no `play` event to clear the flag.
  playRequested = media.paused;
  media.play().catch((error: unknown) => {
    playRequested = false;
    // Autoplay refused: the Lesson stays paused, and the extension is told. Other rejections
    // come from a new load (AbortError) or a failed Lesson, which reports its own `error`.
    if (lesson !== undefined && lesson === current && !lesson.failed && isRefusal(error)) {
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
  writeTime(current, media, Math.min(Math.max(media.currentTime + seconds, 0), end), 'step');
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
      if (current !== undefined) {
        current.playWhenSound = false;
      }
      // Also a sidecar that started and whose video has not yet.
      sidecar.pause();
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
    case 'soundReady':
      soundSettled(command.audioUri, media);
      break;
    case 'soundFailed':
      soundSettled(undefined, media);
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
  // The seek whose target the player wrote for the start position is FollowAlong's own; a seek it
  // did not write, such as the learner's on the seek bar while the start seek is still pending (the
  // browser drops that one for theirs), is not. A step is the learner's. Moving a seek onto media
  // (`adjust`) leaves the seek what it was.
  on('seeking', (lesson) => {
    if (!isOwnSeek(lesson, media)) {
      lesson.startChain = false;
    } else if (lesson.lastWrite?.origin === 'start') {
      lesson.startChain = true;
    } else if (lesson.lastWrite?.origin === 'step') {
      lesson.startChain = false;
    }
  });
  on('seeked', (lesson) => {
    post({ type: 'seeked', ...lesson.about, startSeek: lesson.startChain });
    // A seek has landed: whatever began it is over.
    lesson.startChain = false;
    lesson.lastWrite = undefined;
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

/**
 * Makes the sidecar follow the video, the clock: its pause, seeks and rate, and its playhead
 * whenever the two drift more than {@link maxDriftSeconds} apart.
 */
function followWithSound(media: HTMLVideoElement): void {
  const following = () => current?.sound === 'sidecar';
  media.addEventListener('play', () => {
    // The native control bar's play button, a gesture in the page: the sound joins in.
    if (following() && sidecar.paused) {
      startSound(media).catch(() => undefined);
    }
  });
  media.addEventListener('pause', () => {
    sidecar.pause();
  });
  media.addEventListener('seeking', () => {
    if (following()) {
      sidecar.currentTime = media.currentTime;
    }
  });
  media.addEventListener('ratechange', () => {
    if (following()) {
      alignSound(media);
    }
  });
  media.addEventListener('timeupdate', () => {
    // Not while the sound is still seeking: moving it again would only restart that seek.
    if (following() && !media.paused && !sidecar.seeking) {
      alignSound(media);
    }
  });
  // The native volume slider and mute button, both ways, whatever plays: the sidecar holds the
  // learner's volume and mute from one Lesson to the next.
  media.addEventListener('volumechange', () => {
    sidecar.volume = media.volume;
    sidecar.muted = media.muted;
  });
}

/** A click on the picture plays or pauses the Lesson. */
function togglePlayback(media: HTMLVideoElement): void {
  if (current === undefined || current.failed) {
    return;
  }
  if (current.sound === 'awaited') {
    // The click asks for the Lesson as soon as its sound arrives, or takes that back.
    current.playWhenSound = !current.playWhenSound;
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
reportMediaEvents(video);
followWithSound(video);
reportInteractions(video, overlay);
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const command = parsePlayerCommand(event.data);
  if (command !== undefined) {
    run(command, video);
  }
});
post({ type: 'ready', aacSupported });
