/**
 * The Loaded Lesson: the Lesson the player holds, what the player reported about it, and the
 * playback commands that drive it (play/pause, Rewind, steps, the speed ladder, the status bar).
 * It owns the player page's side of the core: which `load` is current, whether the page takes
 * commands, the rate it plays at, and saving Progress while the Lesson plays. The Course side
 * (`follow-along.ts`) decides which Lesson to load and from which Course.
 */
import {
  wholePicture,
  type AboutLesson,
  type PlayerCommand,
  type PlayerEvent,
  type PlayerSnapshot,
  type ZoomAction,
  type ZoomView,
} from '../protocol/player-messages.js';
import {
  autoPauseOff,
  autoPauseView,
  readAutoPauseMode,
  stepAutoPause,
  type AutoPauseEffect,
  type AutoPauseInput,
  type AutoPauseState,
} from './auto-pause.js';
import type { Lesson } from './course-model.js';
import type { PreparedSound, SoundRequest } from './sidecar-sound.js';
import type { Disposable, PlayerShowResult, Ports } from './ports.js';
import type { PlayheadSeen } from './lesson-status.js';
import { lessonStatus, type ProgressRecorder } from './progress.js';
import { settingSpot, type VideoSpot } from './video-placement.js';
import {
  buildStatusBar,
  hiddenStatusBar,
  type StatusBarCommand,
  type StatusBarModel,
} from './status-bar.js';

/**
 * How long a move waits for the page it leaves to say what it shows (`snapshot`), in ms. A page
 * answers at once; one that does not (hung, or gone) must not hold the move up (ADR 0049).
 */
const snapshotWaitMs = 1000;

/**
 * What a page that starts in a new spot takes over from the page it replaces, once it is ready:
 * its speed and zoom, and whether the Lesson was at its end (ADR 0049).
 */
interface PageRestore {
  readonly rate: number;
  readonly zoom: ZoomView;
  readonly ended: boolean;
}

/** How often Progress is saved while a Lesson plays (spec #12, Progress store). */
const saveIntervalMs = 5000;

/**
 * The most the playhead may move between two `timeUpdate`s of a playing Lesson and still count as
 * play, in seconds. A bigger jump is a seek, which plays nothing. The player reports about every
 * 250 ms, a little more at 2× or while the page is in the background (2 s of picture a second at 2×).
 */
const longestPlayTickSeconds = 3;

export type StepSize = 'short' | 'long';
export type StepDirection = 'back' | 'forward';
export type SpeedDirection = 'up' | 'down';

/** What a playback command tells the learner when no Lesson is loaded. */
export const noLessonText = 'FollowAlong: no Lesson is open. Open a Course first.';

/** What the Loaded Lesson needs from the open Course. */
export interface OpenCourseView {
  /** The open Course's Progress, which the Loaded Lesson's playhead is recorded into. */
  progress(): ProgressRecorder | undefined;
  /** The Lesson after `lesson` in the open Course's Course order, if there is one. */
  lessonAfter(lesson: Lesson): Lesson | undefined;
  /** The learner clicked the Next overlay of the Loaded Lesson: `next` is the Lesson it names. */
  nextClicked(next: Lesson): void;
  /**
   * What `lesson`'s sound needs: its MP3, prepared now or before (the audio sidecar, ADR 0034), or
   * no sidecar. Rejects when it cannot be prepared, or once the request's `signal` aborts.
   */
  prepareSound(lesson: Lesson, request: SoundRequest): Promise<PreparedSound>;
  /**
   * `lesson` is open, and the page needs sound prepared for MP4 Lessons: the sound of the next 3
   * Lessons is prepared ahead, once this Lesson's is. `undefined` when none is open, or the page
   * plays AAC itself; nothing is then prepared ahead, and what was is stopped.
   */
  prepareSoundAhead(lesson: Lesson | undefined, pageDecodes: ReadonlySet<string>): void;
  /**
   * What the Lesson tree shows of the Progress may have changed: a Lesson's state changed, or
   * Progress was saved (every 5 s while playing, on pause and seek). Never called for every
   * `timeUpdate`.
   */
  progressChanged(): void;
}

/** Where and how a Lesson is loaded. */
export interface LoadOptions {
  /** Where the playhead starts, in seconds. */
  readonly startAt: number;
  /** Whether it plays once loaded. */
  readonly autoplay: boolean;
  /** The folders the player may read media from (ADR 0022). */
  readonly resourceRoots: readonly string[];
}

export interface LoadedLesson {
  /** The Loaded Lesson, if any. */
  lesson(): Lesson | undefined;
  /** Shows `lesson` in the player beside the code, and loads it as soon as the player can. */
  load(lesson: Lesson, options: LoadOptions): void;
  /**
   * Brings the player of the Loaded Lesson to the front, in the spot it sits in, without loading
   * the Lesson again. Does nothing while no Lesson is loaded.
   */
  reveal(resourceRoots: readonly string[]): void;
  /**
   * Leaves the Loaded Lesson (another Lesson, another Course, the window closes): no more saves
   * on the clock, its late events are ignored, and the Course's Progress is saved. Resolves once
   * that save, and any save still under way, is written.
   */
  leave(): Promise<void>;
  /**
   * Forgets the Loaded Lesson: nothing is loaded now, so the commands find no Lesson and the
   * status bar items go. With `pause`, a ready player is paused first, so a video it still shows
   * does not play on with every control gone.
   */
  unload(pause: boolean): void;
  /**
   * The play/pause command: pauses the Lesson if the player reports it playing, else resumes it,
   * first stepping back by the `followalong.resumeRewind` setting (a manual resume, ADR 0016).
   */
  playPause(): void;
  /** Resumes a paused Lesson with no rewind, for automatic resumes such as auto-resume. */
  resumeWithoutRewind(): void;
  /**
   * Progress of these Lessons was reset by hand. If the Loaded Lesson is one of them, the play
   * counted so far goes: its 10 s towards "in progress" start again, so the Lesson that keeps
   * playing does not come straight back as in progress.
   */
  progressReset(lessonIds: readonly string[]): void;
  /** Moves the playhead back or forward by the short or the long step setting. */
  seekStep(size: StepSize, direction: StepDirection): void;
  /** Moves the playback rate one rung up or down the speed ladder. */
  speedStep(direction: SpeedDirection): void;
  /**
   * The zoom commands (`Ctrl+'` `Z`, `=`, `-`, `0`): asks the player to change its zoom. Focus stays
   * where it is: a key press never took it.
   */
  zoom(action: ZoomAction): void;
  /** Runs the command a status bar item names, then hands focus back (ADR 0009, ADR 0018). */
  statusBarClick(command: StatusBarCommand): void;
  /**
   * The spot the player of the Loaded Lesson sits in; `undefined` while no Lesson is loaded or no
   * player is open.
   */
  spot(): VideoSpot | undefined;
  /**
   * Moves the player of the Loaded Lesson to `to` (_Move video to…_, ADR 0049). The page it leaves
   * says what it shows, and the page in `to` carries on from it: the playhead, play or pause, the
   * speed and the zoom. Resolves once the page in `to` is starting.
   */
  move(to: VideoSpot): Promise<void>;
  /** The learner typed in the Practice area: an edit auto-pause counts (ADR 0052). */
  typed(): void;
  /** Stops listening to the player and the settings, and cancels the next save. */
  dispose(): void;
}

/** The Loaded Lesson, and how it was loaded. */
interface LessonLoad {
  readonly lesson: Lesson;
  readonly startAt: number;
  readonly autoplay: boolean;
  /**
   * Set once the Lesson has played or the learner moved its playhead. Until then the playhead is
   * where FollowAlong put it, and nothing is saved, so opening a Lesson never moves its position.
   */
  engaged: boolean;
  /**
   * Set by a `load` with a start position, until the player's next `seeked`. A player that tags its
   * `seeked` (`startSeek`) is believed; one that does not is taken to mean this seek is the one
   * applying `startAt`, FollowAlong's own, wherever it lands (gate review of #25, H1; ADR 0030).
   */
  startSeekPending: boolean;
  /** Seconds of picture played since this `load`: the 10 s a Lesson needs to be in progress. */
  playedSeconds: number;
  /** The playhead at the last `timeUpdate` while playing, to count the play since; none after a pause or seek. */
  lastPlayingPosition: number | undefined;
}

/**
 * The sound being prepared for the Loaded Lesson, kept while it stays loaded: a page reload, or the
 * learner picking the same Lesson again, does not start the conversion again.
 */
interface SoundPreparation {
  readonly lesson: Lesson;
  readonly stop: AbortController;
  readonly prepared: Promise<PreparedSound>;
  /** How far the conversion is, once it has started; `undefined` before, and for a sound that needs none. */
  percent: number | undefined;
  /** The percent the player page last shown was told, so each step is sent once per page. */
  sentPercent: number | undefined;
  /** Set once the preparation ended, however it ended: the percent is then nothing to show. */
  settled: boolean;
  /** Set once the failure was logged: a page that reloads is told again, the log is not. */
  loggedFailure: boolean;
  /** Set when the learner chose *Play without sound* after a failure (ADR 0055). */
  withoutSound: boolean;
}

/** The fixed speed ladder (spec #12, story 41), slowest first. */
const slowest = 0.75;
const fastest = 2;
const speedLadder = [slowest, 1, 1.25, 1.5, fastest] as const;
const normalRate = 1;

/** The rung one step from `rate`: the next one beyond it, or the end of the ladder. */
function nextRate(rate: number, direction: SpeedDirection): number {
  return direction === 'up'
    ? (speedLadder.find((rung) => rung > rate) ?? fastest)
    : (speedLadder.findLast((rung) => rung < rate) ?? slowest);
}

/** The rung a click on the status bar speed item goes to: one up, and round to the slowest. */
function cycledRate(rate: number): number {
  return rate >= fastest ? slowest : nextRate(rate, 'up');
}

/** The settings' defaults, in seconds (spec #12, Settings). */
const defaultStepSeconds = { short: 5, long: 30 } as const;
const stepSettings = { short: 'shortStep', long: 'longStep' } as const;

/** What the player reported about the current Lesson since its last `load`. */
interface Playback {
  /** Whether the Lesson is playing. */
  readonly playing: boolean;
  /** Whether the Lesson played to its end; a resume then restarts it, so it is not rewound. */
  readonly ended: boolean;
  /** Set by a `load` with autoplay, until the Lesson plays or pauses. */
  readonly awaitingAutoplay: boolean;
  /** Set when the play/pause command sent `play`, until the player answers it. */
  readonly awaitingPlayAnswer: boolean;
  /** Set when the play/pause command sent `pause`, until the player answers it. */
  readonly awaitingPauseAnswer: boolean;
  /** Whether the learner was told, in this run of refusals, to press play in the player. */
  readonly toldToPressPlay: boolean;
}

function freshPlayback(autoplay: boolean): Playback {
  return {
    playing: false,
    ended: false,
    awaitingAutoplay: autoplay,
    awaitingPlayAnswer: false,
    awaitingPauseAnswer: false,
    toldToPressPlay: false,
  };
}

/**
 * What a `paused` event does to the record, and whether the learner is to be told to press play.
 * - A refused autoplay is told on its own: the `load` that asked for it started the run.
 * - A refused `play` from the command is told once per run of refusals, so repeated keypresses
 *   do not stack messages. A `played` or `ended` (see `onPlayerEvent`) or a `load` ends the run.
 */
function afterPause(
  playback: Playback,
  byUser: boolean,
): { readonly playback: Playback; readonly tellToPressPlay: boolean } {
  const refused = !byUser;
  const autoplayRefused = playback.awaitingAutoplay && refused;
  const commandRefused = playback.awaitingPlayAnswer && refused && !playback.toldToPressPlay;
  return {
    tellToPressPlay: autoplayRefused || commandRefused,
    playback: {
      ...freshPlayback(false),
      toldToPressPlay: playback.toldToPressPlay || commandRefused,
    },
  };
}

/** A seconds setting: any finite number above 0, else `fallback` (a hand-edited value may be bad). */
function positiveSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function pressPlayText(lesson: Lesson): string {
  return `VS Code did not let “${lesson.title}” start by itself. Press play in the player to start it.`;
}

export function createLoadedLesson(
  ports: Pick<Ports, 'player' | 'clock' | 'ui' | 'logger' | 'config'>,
  course: OpenCourseView,
): LoadedLesson {
  const { player, clock, ui, logger, config } = ports;

  let current: LessonLoad | undefined;
  /** How many `load`s were sent, and the `loadId` of the one that loaded `current`, if any. */
  let loads = 0;
  let currentLoad: number | undefined;
  /** The next save while the Lesson plays. */
  let saveTimer: Disposable | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
  /** Whether the open player page can decode AAC, the sound of MP4 Lessons (its `ready`). */
  let aacSupported = false;
  /** The other sound codecs the open player page decodes in an MP4 (its `ready`, ADR 0056). */
  let pageDecodes: ReadonlySet<string> = new Set();
  /** The sound being prepared for the Loaded Lesson, or prepared for it. */
  let sound: SoundPreparation | undefined;
  /** The Rewind the open player page holds; 0 for a page that has just started. */
  let playerResumeRewind = 0;
  /** What the player last said about the current Lesson; starts again with every `load`. */
  let playback = freshPlayback(false);
  /** The playback rate: what the player last reported, or what the core last asked for. */
  let rate: number = normalRate;
  /** Rates asked of the player that it has not reported yet, oldest first. */
  let askedRates: number[] = [];

  /** The playhead and length the player last reported for the current Lesson, in seconds. */
  let position = 0;
  let duration = 0;
  /**
   * The open player page's zoom level, as it last reported it. Zoom belongs to the page, not to
   * the Lesson (ADR 0037): it stays from Lesson to Lesson, and a new page starts at 1×.
   */
  let zoom = 1;
  /**
   * The spot the open player sits in, or `undefined` while no player is open: a new player opens
   * in the spot the `followalong.videoLocation` setting names (ADR 0049).
   */
  let spot: VideoSpot | undefined;
  /** The folders the open player may read media from, as last shown (ADR 0022). */
  let shownRoots: readonly string[] = [];
  /**
   * What a page that is starting in a new spot takes over from the page it replaces, once it is
   * ready: its speed and its zoom (ADR 0049).
   */
  let pendingRestore: PageRestore | undefined;
  /**
   * The spot the learner asked for last while a move waited for its snapshot: the move goes there
   * (review of #49, item 7).
   */
  let requestedSpot: VideoSpot | undefined;
  /** Set while a move waits for the `snapshot` of the page it leaves. */
  let awaitingSnapshot: ((snapshot: PlayerSnapshot | undefined) => void) | undefined;
  /**
   * What a player page that has just started is like (one that posted `ready`, or one that is
   * starting or gone): it plays at normal speed and shows the whole picture, until it says
   * otherwise.
   */
  function newPage(ready: boolean): void {
    playerReady = ready;
    rate = normalRate;
    askedRates = [];
    zoom = 1;
  }

  /** Auto-pause while typing (ADR 0052), as the `followalong.autoPause` setting starts it. */
  let autoPause: AutoPauseState = stepAutoPause(autoPauseOff, {
    type: 'modeChanged',
    mode: readAutoPauseMode(config),
  }).state;

  /** How each thing auto-pause answers is done. */
  const autoPauseEffects: Readonly<Record<AutoPauseEffect, () => void>> = {
    pause: () => {
      player.send({ type: 'pause' });
    },
  };

  /** Feeds auto-pause one input, and does what it answers. */
  function feedAutoPause(input: AutoPauseInput): void {
    const step = stepAutoPause(autoPause, input);
    autoPause = step.state;
    for (const effect of step.effects) {
      autoPauseEffects[effect]();
    }
  }

  /** What the status bar shows now; a new model is sent to the UI only when it differs. */
  let statusBar: StatusBarModel = hiddenStatusBar;

  function refreshStatusBar(): void {
    const next =
      current === undefined
        ? hiddenStatusBar
        : buildStatusBar({
            playing: playback.playing,
            position,
            duration,
            rate,
            shortStep: stepSeconds('short'),
            zoom,
            ...autoPauseView(autoPause),
            soundPercent: sound?.settled === false ? sound.percent : undefined,
          });
    if (JSON.stringify(next) === JSON.stringify(statusBar)) {
      return;
    }
    statusBar = next;
    ui.showStatusBar(next);
  }

  /** Starts what the player reported about a Lesson again: nothing yet. */
  function resetPlayhead(autoplay: boolean): void {
    playback = freshPlayback(autoplay);
    position = 0;
    duration = 0;
    // Until the next `load`, no event is about the Lesson the player should show.
    currentLoad = undefined;
  }

  function loadCurrent(): void {
    if (current === undefined) {
      return;
    }
    const { lesson, startAt, autoplay } = current;
    const command: Extract<PlayerCommand, { type: 'load' }> = {
      type: 'load',
      lessonId: lesson.id,
      videoUri: player.resourceUri(lesson.path),
      container: lesson.container,
      startAt,
      autoplay,
      loadId: loads + 1,
    };
    player.send(command);
    // The player seeks to a start position once it can: that `seeked` is not the learner's.
    current.startSeekPending = startAt > 0;
    resetPlayhead(command.autoplay);
    loads += 1;
    currentLoad = loads;
    sendResumeRewind();
    if (lesson.container === 'mp4' && !aacSupported) {
      sendSoundWhenPrepared(lesson, loads);
    }
    // After the opened Lesson's own sound was asked for, so it goes first in the queue.
    course.prepareSoundAhead(aacSupported ? undefined : lesson, pageDecodes);
  }

  /**
   * Prepares `lesson`'s sound, unless it is already under way, and sends it to the player once
   * prepared, if load `loadId` is still the current one: a later `load` gets its own.
   */
  function sendSoundWhenPrepared(lesson: Lesson, loadId: number): void {
    // A `load` of another Lesson has stopped the sound of the one before (`load`).
    if (sound?.lesson !== lesson) {
      const stop = new AbortController();
      const started: SoundPreparation = {
        lesson,
        stop,
        prepared: course.prepareSound(lesson, {
          signal: stop.signal,
          pageDecodes,
          onProgress: (percent) => {
            soundProgressed(started, percent);
          },
        }),
        percent: undefined,
        sentPercent: undefined,
        settled: false,
        loggedFailure: false,
        withoutSound: false,
      };
      sound = started;
    }
    const preparation = sound;
    // A page that reloaded mid-conversion starts from nothing: it is told where the conversion is.
    preparation.sentPercent = undefined;
    sendSoundProgress(preparation);
    preparation.prepared.then(
      (prepared) => {
        preparation.settled = true;
        if (currentLoad !== loadId || current?.lesson !== lesson) {
          return;
        }
        refreshStatusBar();
        player.send(
          prepared.kind === 'sidecar'
            ? { type: 'soundReady', audioUri: player.resourceUri(prepared.path) }
            : { type: 'noSidecar' },
        );
      },
      (error: unknown) => {
        preparation.settled = true;
        // A Lesson left, or a page reloaded since: the current load reports it, or nobody needs to.
        if (
          preparation.stop.signal.aborted ||
          currentLoad !== loadId ||
          current?.lesson !== lesson
        ) {
          return;
        }
        refreshStatusBar();
        if (preparation.withoutSound) {
          // The learner chose to play this Lesson without its sound: a reloaded page does too.
          player.send({ type: 'noSidecar' });
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (!preparation.loggedFailure) {
          preparation.loggedFailure = true;
          logger.log({
            level: 'error',
            message: `Could not prepare the sound of ${lesson.id}: ${reason}`,
          });
        }
        player.send({ type: 'soundFailed', message: reason });
      },
    );
  }

  /** ffmpeg reported `percent` of `preparation`: the player and the status bar show it. */
  function soundProgressed(preparation: SoundPreparation, percent: number): void {
    // Whole percent, so the player and the status bar always say the same number.
    preparation.percent = Math.floor(percent);
    if (sound === preparation) {
      sendSoundProgress(preparation);
      refreshStatusBar();
    }
  }

  /** Tells the player page the conversion's percent, unless it was told that one already. */
  function sendSoundProgress(preparation: SoundPreparation): void {
    const { percent } = preparation;
    if (
      percent === undefined ||
      preparation.settled ||
      percent === preparation.sentPercent ||
      current?.lesson !== preparation.lesson
    ) {
      return;
    }
    preparation.sentPercent = percent;
    player.send({ type: 'soundProgress', percent });
  }

  /** Stops preparing sound for a Lesson the learner has left. */
  function stopSound(): void {
    sound?.stop.abort();
    sound = undefined;
  }

  /**
   * Tells the player the Rewind for the click that resumes a Lesson there (ADR 0016), when it
   * differs from what the player holds. A fresh player page holds 0, so the default sends nothing.
   */
  function sendResumeRewind(): void {
    const seconds = resumeRewindSeconds();
    if (seconds !== playerResumeRewind) {
      playerResumeRewind = seconds;
      player.send({ type: 'setResumeRewind', seconds });
    }
  }

  /** Saves every 5 s from now on, until the Lesson stops playing. */
  function startSaving(): void {
    saveTimer ??= clock.schedule(saveIntervalMs, () => {
      saveTimer = undefined;
      saveAndShow();
      if (playback.playing) {
        startSaving();
      }
    });
  }

  /** The Lesson stopped playing (paused, ended, failed or left): no more saves on the clock. */
  function stopSaving(): void {
    saveTimer?.dispose();
    saveTimer = undefined;
  }

  /** What the player reported about `shown`, for Progress. */
  function seenOf(shown: LessonLoad, ended: boolean): PlayheadSeen {
    return { position, duration, playedSeconds: shown.playedSeconds, ended };
  }

  /** The playhead is no longer playing on from the last report: the next one starts a count. */
  function stopCountingPlay(shown: LessonLoad): void {
    shown.lastPlayingPosition = undefined;
  }

  /**
   * Records what the player reported about `shown`. Resolves whether that changed the Lesson's
   * state (not started → in progress → done), which the tree must show at once (ADR 0044).
   */
  function recordPlayhead(shown: LessonLoad, seen: PlayheadSeen): boolean {
    const progress = course.progress();
    if (progress === undefined) {
      return false;
    }
    const before = lessonStatus(progress.current(), shown.lesson.id);
    progress.record(shown.lesson.id, seen);
    return lessonStatus(progress.current(), shown.lesson.id) !== before;
  }

  /** Saves Progress now, and lets the tree show what was saved (ADR 0044). */
  function saveAndShow(): void {
    void course.progress()?.save();
    course.progressChanged();
  }

  /** Records what the player reported about `shown` and saves it now. */
  function recordAndSave(shown: LessonLoad, seen: PlayheadSeen): void {
    recordPlayhead(shown, seen);
    saveAndShow();
  }

  /** Counts the play between the last `timeUpdate` of a playing Lesson and this one at `at`. */
  function countPlay(shown: LessonLoad, at: number): void {
    if (!playback.playing) {
      return;
    }
    const before = shown.lastPlayingPosition;
    shown.lastPlayingPosition = at;
    const played = before === undefined ? 0 : at - before;
    if (played > 0 && played <= longestPlayTickSeconds) {
      shown.playedSeconds += played;
    }
  }

  /**
   * The Lesson the player shows now, if `event` is about it and not a late one about the last. The
   * same Lesson id is not enough: the page outlives a Course (ADR 0022), and another Course can
   * hold a Lesson with the same id, so the event must also come from the current `load`.
   */
  function shownLesson(event: AboutLesson): LessonLoad | undefined {
    return event.lessonId === current?.lesson.id &&
      currentLoad !== undefined &&
      event.loadId === currentLoad
      ? current
      : undefined;
  }

  function onPlayerEvent(event: PlayerEvent): void {
    switch (event.type) {
      case 'ready':
        // A page that kept its zoom reports it right after `ready`.
        newPage(true);
        aacSupported = event.aacSupported;
        pageDecodes = new Set(event.soundCodecs);
        playerResumeRewind = 0;
        logger.log({
          level: 'debug',
          message: `Player ready (AAC ${event.aacSupported ? 'supported' : 'not supported'})`,
        });
        if (current?.engaged === true) {
          // A page that reloaded mid-Lesson starts again where the playhead was, not where the
          // Lesson first started: its start seek then saves nothing and moves nothing back.
          current = {
            ...current,
            startAt: position,
            autoplay: playback.playing,
            engaged: false,
            lastPlayingPosition: undefined,
          };
        }
        loadCurrent();
        restorePage();
        break;
      case 'error': {
        logger.log({
          level: 'error',
          message: `Player error in ${event.lessonId}: ${event.message}`,
        });
        const shown = shownLesson(event);
        if (shown !== undefined) {
          // The player posts nothing more for a failed Lesson (ADR 0003), not even a pause.
          stopSaving();
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong could not play “${shown.lesson.title}”: ${event.message}`,
          });
        }
        break;
      }
      case 'paused': {
        const shown = shownLesson(event);
        if (shown === undefined) {
          break;
        }
        // A pause the learner did not ask for after a `load` with autoplay, or after the command's
        // `play`: VS Code refused it. Without a word the learner would face a stopped video.
        const after = afterPause(playback, event.byUser);
        playback = after.playback;
        if (event.byUser) {
          feedAutoPause({ type: 'learnerPaused' });
        }
        if (after.tellToPressPlay) {
          ui.showMessage({ severity: 'info', text: pressPlayText(shown.lesson) });
        }
        stopSaving();
        stopCountingPlay(shown);
        if (shown.engaged) {
          saveAndShow();
        }
        break;
      }
      case 'played': {
        const shown = shownLesson(event);
        if (shown !== undefined) {
          // Also ends a run of refusals: the player did what it was asked.
          playback = { ...freshPlayback(false), playing: true };
          feedAutoPause({ type: 'played' });
          shown.engaged = true;
          stopCountingPlay(shown);
          startSaving();
        }
        break;
      }
      case 'ended': {
        const shown = shownLesson(event);
        if (shown !== undefined) {
          // Ended: a resume then restarts the Lesson, so it is not rewound (ADR 0016).
          playback = { ...freshPlayback(false), ended: true };
          feedAutoPause({ type: 'lessonOver' });
          stopSaving();
          shown.engaged = true;
          stopCountingPlay(shown);
          // At its end the playhead is at the Lesson's length, which a done Lesson restarts from.
          recordAndSave(shown, {
            ...seenOf(shown, true),
            position: duration > 0 ? duration : position,
          });
          offerNextLesson(shown.lesson);
        }
        break;
      }
      case 'timeUpdate': {
        const shown = shownLesson(event);
        if (shown !== undefined) {
          countPlay(shown, event.position);
          position = event.position;
          duration = event.duration;
          if (shown.engaged && recordPlayhead(shown, seenOf(shown, false))) {
            course.progressChanged();
          }
        }
        break;
      }
      case 'seeked': {
        // A seek is the learner moving the playhead, playing or not: it counts, and saves now.
        // The player's timeUpdate at the new position comes before it (HTML seek steps).
        const shown = shownLesson(event);
        if (shown === undefined) {
          break;
        }
        // The player says which seek applied `startAt`. One that does not say is taken to be the
        // first `seeked` after a `load` with a start position (ADR 0010).
        const isStartSeek = event.startSeek ?? shown.startSeekPending;
        shown.startSeekPending = false;
        if (isStartSeek) {
          // FollowAlong's own seek to `startAt`: saving it would move the Lesson's position. It
          // leaves a Lesson moved at its end ended (ADR 0049).
          break;
        }
        if (playback.ended) {
          // A Lesson moved off its end (a step back, the seek bar) is no longer ended.
          playback = { ...playback, ended: false };
        }
        shown.engaged = true;
        stopCountingPlay(shown);
        recordAndSave(shown, seenOf(shown, false));
        break;
      }
      case 'nextClicked': {
        // A click for a Lesson the learner has left, or one no Course holds any more, is stale.
        const shown = shownLesson(event);
        const next = shown === undefined ? undefined : course.lessonAfter(shown.lesson);
        if (next !== undefined) {
          // A Lesson switch like any other: the Lesson left is saved, the next resumes 5 s back.
          course.nextClicked(next);
        }
        break;
      }
      case 'playWithoutSound': {
        // The learner chose the picture alone after the sound failed (ADR 0055). Remembered while
        // the Lesson stays loaded, so a page that reloads does not show the error again.
        if (shownLesson(event) !== undefined && sound?.lesson === current?.lesson) {
          if (sound !== undefined) {
            sound.withoutSound = true;
          }
          logger.log({
            level: 'info',
            message: `Playing ${event.lessonId} without its sound, as the learner chose`,
          });
        }
        break;
      }
      case 'rateChanged': {
        // The answer to a press still counts it and every press before it; a late answer must not
        // undo the presses after it. A rate the core did not ask for replaces them: the player
        // reports every change, whoever made it, so the core never works from a stale rate.
        const answered = askedRates.indexOf(event.rate);
        if (answered === -1) {
          askedRates = [];
          rate = event.rate;
        } else {
          askedRates = askedRates.slice(answered + 1);
          rate = askedRates.at(-1) ?? event.rate;
        }
        break;
      }
      case 'userInteracted':
        ui.returnFocus();
        break;
      case 'zoomChanged':
        zoom = event.level;
        break;
      case 'snapshot':
        awaitingSnapshot?.(event.snapshot);
        break;
    }
    refreshStatusBar();
  }

  /**
   * The Lesson has ended: the player stops on its last frame and, when a Lesson follows in Course
   * order, shows "Next: <title>". The core never loads it by itself (spec #12, story 50); that is
   * the learner's click on the overlay, or `nextLesson`.
   */
  function offerNextLesson(lesson: Lesson): void {
    const next = course.lessonAfter(lesson);
    if (next !== undefined) {
      player.send({ type: 'showNext', title: next.title });
    }
  }

  function leave(): Promise<void> {
    stopSaving();
    feedAutoPause({ type: 'lessonOver' });
    // The sound under way is kept: the next `load` may be this Lesson again (picked once more), and
    // a `load` of another Lesson, or `unload`, stops it.
    // From now on its late events are ignored, so none is recorded into the next Course.
    current = undefined;
    // Also waits for a save still under way, such as the one of the Lesson before.
    return course.progress()?.save() ?? Promise.resolve();
  }

  function unload(pause: boolean): void {
    if (pause && playerReady) {
      player.send({ type: 'pause' });
    }
    current = undefined;
    feedAutoPause({ type: 'lessonOver' });
    stopSound();
    course.prepareSoundAhead(undefined, pageDecodes);
    resetPlayhead(false);
    refreshStatusBar();
  }

  /** The learner closed the player: a new page starts from scratch, at normal speed. */
  function onPlayerClosed(): void {
    newPage(false);
    spot = undefined;
    pendingRestore = undefined;
    awaitingSnapshot?.(undefined);
    // Closing the player closes the Lesson's playback: its Progress is saved now (spec #12).
    void leave();
    // The Lesson shows where it was left, saved with it.
    course.progressChanged();
    unload(false);
  }

  const subscriptions: Disposable[] = [
    player.onEvent(onPlayerEvent),
    player.onDidClose(onPlayerClosed),
    // The back item names the short step, so a changed setting shows at once.
    config.onDidChange((affects) => {
      if (affects(stepSettings.short)) {
        refreshStatusBar();
      }
      if (playerReady && affects('resumeRewind')) {
        sendResumeRewind();
      }
      if (affects('autoPause')) {
        feedAutoPause({ type: 'modeChanged', mode: readAutoPauseMode(config) });
        refreshStatusBar();
      }
    }),
  ];

  function load(lesson: Lesson, options: LoadOptions): void {
    const { startAt, autoplay, resourceRoots } = options;
    // A safety net: every caller has left the Lesson before (`leave`), which stops its saves. A
    // timer still running would write the Lesson before into this Lesson's Course.
    stopSaving();
    if (sound?.lesson !== lesson) {
      stopSound();
    }
    current = {
      lesson,
      startAt,
      autoplay,
      engaged: false,
      startSeekPending: false,
      playedSeconds: 0,
      lastPlayingPosition: undefined,
    };
    // Nothing is known about this Lesson until the player loads it and reports.
    resetPlayhead(false);
    if (showPlayer(lesson, resourceRoots) === 'revealed' && playerReady) {
      loadCurrent();
    }
    refreshStatusBar();
  }

  /** Shows the player for `lesson` in its spot; a page that is starting is a new page. */
  function showPlayer(lesson: Lesson, resourceRoots: readonly string[]): PlayerShowResult {
    spot ??= settingSpot(config);
    shownRoots = resourceRoots;
    const result = player.show({ title: lesson.title, resourceRoots, spot });
    if (result === 'created') {
      newPage(false);
    }
    return result;
  }

  /**
   * Asks the open page what it shows and plays. Resolves `undefined` when it does not answer in
   * time, or is closed meanwhile.
   */
  function takeSnapshot(): Promise<PlayerSnapshot | undefined> {
    return new Promise((resolve) => {
      const finish = (snapshot: PlayerSnapshot | undefined): void => {
        timer.dispose();
        awaitingSnapshot = undefined;
        resolve(snapshot);
      };
      const timer = clock.schedule(snapshotWaitMs, () => {
        logger.log({
          level: 'warn',
          message: 'The player did not say what it shows: moving it with what FollowAlong knows.',
        });
        finish(undefined);
      });
      awaitingSnapshot = finish;
      player.send({ type: 'takeSnapshot' });
    });
  }

  /**
   * Where the moved Lesson starts in the new page, and whether it plays: what the page it leaves
   * said, or else what the core knows. A Lesson the learner has not engaged with yet starts where
   * FollowAlong put it.
   */
  function carriedPlayhead(
    shown: LessonLoad,
    snapshot: PlayerSnapshot | undefined,
  ): { readonly position: number; readonly playing: boolean } {
    const reported = snapshot?.lesson;
    if (reported !== undefined && shownLesson(reported) === shown) {
      return { position: reported.position, playing: reported.playing };
    }
    if (!playerReady) {
      return { position: shown.startAt, playing: shown.autoplay };
    }
    // A Lesson loaded with autoplay that has not played yet (its sound may still be preparing)
    // is still to play, unless it has ended.
    const playing = playback.playing || (playback.awaitingAutoplay && !playback.ended);
    return { position: shown.engaged ? position : shown.startAt, playing };
  }

  /** Whether `shown` is still the Loaded Lesson, in an open player. */
  function stillLoaded(shown: LessonLoad): boolean {
    return current === shown && spot !== undefined;
  }

  async function move(to: VideoSpot): Promise<void> {
    // `moveVideo` has told the learner already: it asks `spot()` before it asks for a spot.
    if (current === undefined || spot === undefined) {
      return;
    }
    requestedSpot = to;
    if (awaitingSnapshot !== undefined) {
      // The move under way waits for its snapshot; it goes where the learner asked last.
      logger.log({ level: 'info', message: `Moving the video to ${to} instead, once it can` });
      return;
    }
    const shown = current;
    const snapshot =
      to !== spot && playerReady && currentLoad !== undefined ? await takeSnapshot() : undefined;
    const target = requestedSpot;
    requestedSpot = undefined;
    if (target === spot) {
      return;
    }
    if (!stillLoaded(shown)) {
      logger.log({
        level: 'info',
        message: 'Not moving the video: the player closed or another Lesson loaded meanwhile.',
      });
      return;
    }
    const carried = carriedPlayhead(shown, snapshot);
    stopSaving();
    if (shown.engaged) {
      position = carried.position;
      recordAndSave(shown, seenOf(shown, false));
    }
    // Like a page that reloaded mid-Lesson: the new page starts where the playhead was, and its
    // start seek is FollowAlong's own, so it saves nothing (ADR 0030).
    current = {
      ...shown,
      startAt: carried.position,
      autoplay: carried.playing,
      engaged: false,
      startSeekPending: false,
      lastPlayingPosition: undefined,
    };
    // Without a snapshot the zoom view is unknown: the whole picture, rather than whatever a view
    // spot used before still holds in its webview state.
    // A page that is still starting has nothing to say: what the page before it held is kept for
    // the next page (review of #49, item 1).
    const ended =
      snapshot === undefined ? (pendingRestore?.ended ?? playback.ended) : playback.ended;
    pendingRestore =
      snapshot === undefined
        ? { ...(pendingRestore ?? { rate, zoom: wholePicture }), ended }
        : { rate: snapshot.rate, zoom: snapshot.zoom, ended };
    // The page that held this load is gone: nothing (a prepared sound) is sent for it, and nothing
    // it still posts is about the Lesson. The page in the new spot gets its own `load`.
    currentLoad = undefined;
    logger.log({ level: 'info', message: `Moving the video from ${spot} to ${target}` });
    spot = target;
    showPlayer(current.lesson, shownRoots);
    refreshStatusBar();
  }

  /** A page that started in a new spot takes over the speed and zoom of the page it replaced. */
  function restorePage(): void {
    const restore = pendingRestore;
    pendingRestore = undefined;
    if (restore === undefined) {
      return;
    }
    if (restore.rate !== rate) {
      setRate(restore.rate);
    }
    // Also at the whole picture: a view spot keeps the webview state of the page it held before,
    // and that page's zoom must not come back.
    player.send({ type: 'restore', zoom: restore.zoom });
    if (restore.ended) {
      // Still at its end: a resume restarts it rather than stepping back (ADR 0016).
      playback = { ...playback, ended: true };
    }
  }

  /**
   * Whether a playback command can be sent now. Tells the learner when no Lesson is open; ignores
   * the command while the page is still starting, because it takes no command yet and plays the
   * Lesson when it is ready.
   */
  function hasPlayableLesson(command: string): boolean {
    if (current === undefined) {
      ui.showMessage({ severity: 'info', text: noLessonText });
      return false;
    }
    if (!playerReady) {
      logger.log({ level: 'debug', message: `${command} ignored: the player is not ready yet.` });
      return false;
    }
    return true;
  }

  /** Asks the player to change its zoom. It knows what it shows, and reports the level. */
  function zoomPlayer(action: ZoomAction): void {
    if (hasPlayableLesson('Zoom')) {
      player.send({ type: 'zoom', action });
    }
  }

  /** The step in seconds, read when the command runs so a changed setting counts at once. */
  function stepSeconds(size: StepSize): number {
    return positiveSetting(config.get(stepSettings[size]), defaultStepSeconds[size]);
  }

  /** The seconds a manual resume steps back, read when the command runs; 0 when unset or invalid. */
  function resumeRewindSeconds(): number {
    return positiveSetting(config.get('resumeRewind'), 0);
  }

  /** Sends `play`, after a `seekBy` back of `rewind` seconds when that is above 0. */
  function resume(rewind: number): void {
    const wasAwaiting = playback.awaitingPlayAnswer;
    playback = { ...playback, awaitingPlayAnswer: true };
    // A second press before the player answers must not rewind again.
    if (rewind > 0 && !playback.ended && !wasAwaiting) {
      player.send({ type: 'seekBy', seconds: -rewind });
    }
    player.send({ type: 'play' });
  }

  function playPause(): void {
    if (!hasPlayableLesson('Play/pause')) {
      return;
    }
    if (playback.playing) {
      playback = { ...playback, awaitingPauseAnswer: true };
      player.send({ type: 'pause' });
      feedAutoPause({ type: 'learnerPaused' });
      return;
    }
    resume(resumeRewindSeconds());
  }

  function seekStep(size: StepSize, direction: StepDirection): void {
    if (!hasPlayableLesson('Seek step')) {
      return;
    }
    const seconds = stepSeconds(size);
    player.send({ type: 'seekBy', seconds: direction === 'back' ? -seconds : seconds });
  }

  /** Asks the player for `next`, the rung a speed command chose. */
  function setRate(next: number): void {
    // Counted at once, so presses in a row climb before the player has answered the first.
    if (next !== rate) {
      // The player reports only a change, so a press that changes nothing has no answer to wait for.
      askedRates.push(next);
    }
    rate = next;
    player.send({ type: 'setRate', rate });
    refreshStatusBar();
  }

  return {
    lesson: () => current?.lesson,
    load,
    spot: () => (current === undefined ? undefined : spot),
    move,
    reveal(resourceRoots) {
      if (current !== undefined) {
        showPlayer(current.lesson, resourceRoots);
      }
    },
    leave,
    unload,
    playPause,
    resumeWithoutRewind() {
      // Silent: an automatic resume must not tell the learner anything they did not ask for.
      if (current === undefined || !playerReady || playback.playing) {
        return;
      }
      resume(0);
    },
    seekStep,
    speedStep(direction) {
      if (hasPlayableLesson('Speed step')) {
        setRate(nextRate(rate, direction));
      }
    },
    zoom: zoomPlayer,
    statusBarClick(command) {
      switch (command) {
        case 'playPause':
          playPause();
          break;
        case 'seekBackShort':
          seekStep('short', 'back');
          break;
        case 'speedCycle':
          if (hasPlayableLesson('Speed cycle')) {
            setRate(cycledRate(rate));
          }
          break;
        case 'zoomReset':
          // The item goes once the player reports the whole picture: it knows what it shows.
          zoomPlayer('reset');
          break;
      }
      // The click gives the status bar item keyboard focus (VS Code makes the label focusable):
      // hand it back to the editor or terminal the learner used last (Focus return, ADR 0009).
      ui.returnFocus();
    },
    typed() {
      feedAutoPause({
        type: 'typed',
        // Only a Lesson the player reports playing is paused: a pause sent to a page that is still
        // starting would be lost.
        // A Lesson the learner is pausing already stays their pause: auto-pause did not cause it.
        playing:
          current !== undefined && playerReady && playback.playing && !playback.awaitingPauseAnswer,
      });
    },
    progressReset(lessonIds) {
      if (current !== undefined && lessonIds.includes(current.lesson.id)) {
        current.playedSeconds = 0;
        current.lastPlayingPosition = undefined;
      }
    },
    dispose() {
      saveTimer?.dispose();
      stopSound();
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
