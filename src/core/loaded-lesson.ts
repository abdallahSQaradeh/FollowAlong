/**
 * The Loaded Lesson: the Lesson the player holds, what the player reported about it, and the
 * playback commands that drive it (play/pause, Rewind, steps, the speed ladder, the status bar).
 * It owns the player page's side of the core: which `load` is current, whether the page takes
 * commands, the rate it plays at, and saving Progress while the Lesson plays. The Course side
 * (`follow-along.ts`) decides which Lesson to load and from which Course.
 */
import type { AboutLesson, PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import type { Lesson } from './course-model.js';
import type { Disposable, Ports } from './ports.js';
import type { PlayheadSeen } from './lesson-status.js';
import type { ProgressRecorder } from './progress.js';
import {
  buildStatusBar,
  hiddenStatusBar,
  type StatusBarCommand,
  type StatusBarModel,
} from './status-bar.js';

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
   * The path of `lesson`'s sound as an MP3, prepared now or before (the audio sidecar, ADR 0034).
   * Rejects when it cannot be prepared, or once `signal` aborts.
   */
  prepareSound(lesson: Lesson, signal: AbortSignal): Promise<string>;
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
  /** Moves the playhead back or forward by the short or the long step setting. */
  seekStep(size: StepSize, direction: StepDirection): void;
  /** Moves the playback rate one rung up or down the speed ladder. */
  speedStep(direction: SpeedDirection): void;
  /** Runs the command a status bar item names, then hands focus back (ADR 0009, ADR 0018). */
  statusBarClick(command: StatusBarCommand): void;
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
  readonly path: Promise<string>;
  /** Set once the learner was told it failed: a page that reloads is told again, they are not. */
  toldFailure: boolean;
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
  /** Whether the learner was told, in this run of refusals, to press play in the player. */
  readonly toldToPressPlay: boolean;
}

function freshPlayback(autoplay: boolean): Playback {
  return {
    playing: false,
    ended: false,
    awaitingAutoplay: autoplay,
    awaitingPlayAnswer: false,
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
  }

  /**
   * Prepares `lesson`'s sound, unless it is already under way, and sends it to the player once
   * prepared, if load `loadId` is still the current one: a later `load` gets its own.
   */
  function sendSoundWhenPrepared(lesson: Lesson, loadId: number): void {
    // A `load` of another Lesson has stopped the sound of the one before (`load`).
    if (sound?.lesson !== lesson) {
      const stop = new AbortController();
      sound = { lesson, stop, path: course.prepareSound(lesson, stop.signal), toldFailure: false };
    }
    const preparation = sound;
    preparation.path.then(
      (path) => {
        if (currentLoad === loadId && current?.lesson === lesson) {
          player.send({ type: 'soundReady', audioUri: player.resourceUri(path) });
        }
      },
      (error: unknown) => {
        // A Lesson left, or a page reloaded since: the current load reports it, or nobody needs to.
        if (
          preparation.stop.signal.aborted ||
          currentLoad !== loadId ||
          current?.lesson !== lesson
        ) {
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (!preparation.toldFailure) {
          preparation.toldFailure = true;
          logger.log({
            level: 'error',
            message: `Could not prepare the sound of ${lesson.id}: ${reason}`,
          });
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong could not prepare the sound of “${lesson.title}”: ${reason}`,
          });
        }
        player.send({ type: 'soundFailed', message: reason });
      },
    );
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
      void course.progress()?.save();
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

  /** Records what the player reported about `shown` and saves it now. */
  function recordAndSave(shown: LessonLoad, seen: PlayheadSeen): void {
    const progress = course.progress();
    progress?.record(shown.lesson.id, seen);
    void progress?.save();
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
        if (after.tellToPressPlay) {
          ui.showMessage({ severity: 'info', text: pressPlayText(shown.lesson) });
        }
        stopSaving();
        stopCountingPlay(shown);
        if (shown.engaged) {
          void course.progress()?.save();
        }
        break;
      }
      case 'played': {
        const shown = shownLesson(event);
        if (shown !== undefined) {
          // Also ends a run of refusals: the player did what it was asked.
          playback = { ...freshPlayback(false), playing: true };
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
          if (shown.engaged) {
            course.progress()?.record(shown.lesson.id, seenOf(shown, false));
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
        if (playback.ended) {
          // A Lesson moved off its end (a step back, the seek bar) is no longer ended.
          playback = { ...playback, ended: false };
        }
        // The player says which seek applied `startAt`. One that does not say is taken to be the
        // first `seeked` after a `load` with a start position (ADR 0010).
        const isStartSeek = event.startSeek ?? shown.startSeekPending;
        shown.startSeekPending = false;
        if (isStartSeek) {
          // FollowAlong's own seek to `startAt`: saving it would move the Lesson's position.
          break;
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
    stopSound();
    resetPlayhead(false);
    refreshStatusBar();
  }

  /** The learner closed the player: a new page starts from scratch, at normal speed. */
  function onPlayerClosed(): void {
    newPage(false);
    // Closing the player closes the Lesson's playback: its Progress is saved now (spec #12).
    void leave();
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
    const shown = player.show({ title: lesson.title, resourceRoots });
    if (shown === 'created') {
      newPage(false);
    } else if (playerReady) {
      loadCurrent();
    }
    refreshStatusBar();
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
      player.send({ type: 'pause' });
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
          if (hasPlayableLesson('Zoom reset')) {
            player.send({ type: 'zoom', action: 'reset' });
          }
          break;
      }
      // The click gives the status bar item keyboard focus (VS Code makes the label focusable):
      // hand it back to the editor or terminal the learner used last (Focus return, ADR 0009).
      ui.returnFocus();
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
