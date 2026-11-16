/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import { buildCourse, lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { FileSystemError, type Disposable, type Ports } from './ports.js';
import { buildLessonPicker } from './lesson-picker.js';
import { buildLessonTree } from './lesson-tree.js';
import { readFolderListing } from './folder-listing.js';

export interface FollowAlong {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** Plays a Lesson of the open Course, by its id, beside the code. */
  playLesson(lessonId: string): void;
  /**
   * The play/pause command: pauses the Lesson if the player reports it playing, else resumes it,
   * first stepping back by the `followalong.resumeRewind` setting (a manual resume, ADR 0016).
   */
  playPause(): void;
  /** Resumes a paused Lesson with no rewind, for automatic resumes such as auto-resume. */
  resumeWithoutRewind(): void;
  /**
   * The step commands: moves the playhead back or forward by the short or the long step, as the
   * `followalong.shortStep` and `followalong.longStep` settings are when the command runs.
   */
  seekStep(size: StepSize, direction: StepDirection): void;
  /** The speed commands: moves the playback rate one rung up or down the speed ladder. */
  speedStep(direction: SpeedDirection): void;
  /** Lists the open Course's Lessons by Section in a quick pick, and plays the one picked. */
  goToLesson(): Promise<void>;
  dispose(): void;
}

export type StepSize = 'short' | 'long';
export type StepDirection = 'back' | 'forward';
export type SpeedDirection = 'up' | 'down';

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

export function createFollowAlong(ports: Ports): FollowAlong {
  const { player, storage, ui, logger, config } = ports;

  /** The Lesson the player should show. */
  let current: Lesson | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
  /** The Rewind the open player page holds; 0 for a page that has just started. */
  let playerResumeRewind = 0;
  /** What the player last said about the current Lesson; starts again with every `load`. */
  let playback = freshPlayback(false);
  /** The playback rate: what the player last reported, or what the core last asked for. */
  let rate: number = normalRate;
  /** Rates asked of the player that it has not reported yet, oldest first. */
  let askedRates: number[] = [];

  function loadCurrent(): void {
    if (current === undefined) {
      return;
    }
    const command: Extract<PlayerCommand, { type: 'load' }> = {
      type: 'load',
      lessonId: current.id,
      videoUri: player.resourceUri(current.path),
      container: current.container,
      startAt: 0,
      autoplay: true,
    };
    player.send(command);
    playback = freshPlayback(command.autoplay);
    sendResumeRewind();
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

  function onPlayerEvent(event: PlayerEvent): void {
    switch (event.type) {
      case 'ready':
        playerReady = true;
        playerResumeRewind = 0;
        rate = normalRate;
        askedRates = [];
        logger.log({
          level: 'debug',
          message: `Player ready (AAC ${event.aacSupported ? 'supported' : 'not supported'})`,
        });
        loadCurrent();
        break;
      case 'error':
        logger.log({
          level: 'error',
          message: `Player error in ${event.lessonId}: ${event.message}`,
        });
        if (event.lessonId === current?.id) {
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong could not play “${current.title}”: ${event.message}`,
          });
        }
        break;
      case 'paused':
        // A pause the learner did not ask for after a `load` with autoplay, or after the command's
        // `play`: VS Code refused it. Without a word the learner would face a stopped video.
        if (event.lessonId === current?.id) {
          const after = afterPause(playback, event.byUser);
          playback = after.playback;
          if (after.tellToPressPlay) {
            ui.showMessage({ severity: 'info', text: pressPlayText(current) });
          }
        }
        break;
      case 'played':
      case 'ended':
        if (event.lessonId === current?.id) {
          // Also ends a run of refusals: the player did what it was asked.
          playback = {
            ...freshPlayback(false),
            playing: event.type === 'played',
            ended: event.type === 'ended',
          };
        }
        break;
      case 'rateChanged': {
        // The answer to a press still counts it and every press before it; a late answer must not
        // undo the presses after it. A rate nobody asked for (the video's own menu) replaces them.
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
      case 'seeked':
        // A Lesson moved off its end (a step back, the seek bar) is no longer ended.
        if (event.lessonId === current?.id && playback.ended) {
          playback = { ...playback, ended: false };
        }
        break;
      case 'timeUpdate':
        break;
    }
  }

  const subscriptions: Disposable[] = [
    player.onEvent(onPlayerEvent),
    config.onDidChange((affects) => {
      if (playerReady && affects('resumeRewind')) {
        sendResumeRewind();
      }
    }),
  ];

  /** The open Course: what the Lesson tree shows, and where `playLesson` looks up a Lesson. */
  let openedCourse: Course | undefined;

  /** Shows `lesson` in the player beside the code, and loads it as soon as the player can. */
  function play(course: Course, lesson: Lesson): void {
    current = lesson;
    logger.log({ level: 'info', message: `Playing ${lesson.id} of ${course.folder}` });
    const shown = player.show({
      title: lesson.title,
      resourceRoots: [course.folder, storage.folder],
    });
    if (shown === 'created') {
      playerReady = false;
    } else if (playerReady) {
      loadCurrent();
    }
  }

  /**
   * Whether a playback command can be sent now. Tells the learner when no Lesson is open; ignores
   * the command while the page is still starting, because it takes no command yet and plays the
   * Lesson when it is ready.
   */
  function hasPlayableLesson(command: string): boolean {
    if (current === undefined) {
      ui.showMessage({
        severity: 'info',
        text: 'FollowAlong: no Lesson is open. Open a Course first.',
      });
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

  /** Plays a Lesson of the open Course, by its id. */
  function playLesson(lessonId: string): void {
    const course = openedCourse;
    const lesson = course && lessonsInOrder(course).find((candidate) => candidate.id === lessonId);
    if (course === undefined || lesson === undefined) {
      logger.log({
        level: 'warn',
        message: `Cannot play ${lessonId}: it is not a Lesson of the open Course.`,
      });
      return;
    }
    play(course, lesson);
  }

  return {
    async openCourse(folder) {
      let course: Course;
      try {
        course = buildCourse(await readFolderListing(ports, folder, basename(folder)));
      } catch (error) {
        if (FileSystemError.is(error, 'notFound')) {
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong cannot open “${basename(folder)}”: the folder is missing.`,
          });
          return;
        }
        throw error;
      }
      openedCourse = course;
      const first = lessonsInOrder(course)[0];
      if (first === undefined) {
        const text = `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(folder)}”. If the Course is zipped, extract it first.`;
        ui.showLessonTree({ message: text, nodes: [] });
        ui.showMessage({ severity: 'warning', text });
        return;
      }
      ui.showLessonTree(buildLessonTree(course));
      logger.log({ level: 'info', message: `Opened Course ${folder}` });
      play(course, first);
    },
    playLesson,
    async goToLesson() {
      if (openedCourse === undefined) {
        ui.showMessage({
          severity: 'info',
          text: 'FollowAlong has no Course open. Run “FollowAlong: Open Course…” to pick one.',
        });
        return;
      }
      const course = openedCourse;
      const intent = await ui.pick(buildLessonPicker(course));
      if (intent?.type === 'playLesson') {
        if (course === openedCourse) {
          playLesson(intent.lessonId);
        } else {
          logger.log({
            level: 'info',
            message: `Ignored ${intent.lessonId}: another Course was opened while the picker was open.`,
          });
        }
      }
    },
    playPause() {
      if (!hasPlayableLesson('Play/pause')) {
        return;
      }
      if (playback.playing) {
        player.send({ type: 'pause' });
        return;
      }
      resume(resumeRewindSeconds());
    },
    resumeWithoutRewind() {
      // Silent: an automatic resume must not tell the learner anything they did not ask for.
      if (current === undefined || !playerReady || playback.playing) {
        return;
      }
      resume(0);
    },
    seekStep(size, direction) {
      if (!hasPlayableLesson('Seek step')) {
        return;
      }
      const seconds = stepSeconds(size);
      player.send({ type: 'seekBy', seconds: direction === 'back' ? -seconds : seconds });
    },
    speedStep(direction) {
      if (!hasPlayableLesson('Speed step')) {
        return;
      }
      // Counted at once, so presses in a row climb before the player has answered the first.
      const next = nextRate(rate, direction);
      if (next !== rate) {
        // The player reports only a change, so a press that changes nothing has no answer to wait for.
        askedRates.push(next);
      }
      rate = next;
      player.send({ type: 'setRate', rate });
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
