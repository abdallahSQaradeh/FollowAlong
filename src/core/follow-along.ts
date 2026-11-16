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
import { openProgress, resumePosition, type ProgressRecorder } from './progress.js';

/** Workspace storage key: the folder of the Course open in this workspace (story 21). */
const openCourseKey = 'openCourse';

/** How often Progress is saved while a Lesson plays (spec #12, Progress store). */
const saveIntervalMs = 5000;

export interface FollowAlong {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** Opens the Course that was open in this workspace, if any, paused where the learner left it. */
  restoreCourse(): Promise<void>;
  /** Plays a Lesson of the open Course, by its id, beside the code. */
  playLesson(lessonId: string): void;
  /** The play/pause command: pauses the Lesson if the player reports it playing, else plays it. */
  playPause(): void;
  /**
   * The step commands: moves the playhead back or forward by the short or the long step, as the
   * `followalong.shortStep` and `followalong.longStep` settings are when the command runs.
   */
  seekStep(size: StepSize, direction: StepDirection): void;
  /** Lists the open Course's Lessons by Section in a quick pick, and plays the one picked. */
  goToLesson(): Promise<void>;
  /** The window is closing: saves Progress, then stops. */
  close(): Promise<void>;
  /** Stops at once, without saving (tests use it as a crash). */
  dispose(): void;
}

/** The Lesson the player shows, and how it was loaded. */
interface CurrentLesson {
  readonly lesson: Lesson;
  readonly startAt: number;
  readonly autoplay: boolean;
  /**
   * Set once the Lesson has played or the learner moved its playhead. Until then the playhead is
   * where FollowAlong put it, and nothing is saved, so opening a Lesson never moves its position.
   */
  engaged: boolean;
  /** Where the player last reported the playhead, and the Lesson's length. */
  position: number;
  duration: number;
}

/**
 * How close to the start position a seek lands when it is the one that applies `startAt` (the
 * player moves a WebM seek onto the first buffered frame, under 0.1 s away; ADR 0006).
 */
const startSeekToleranceSeconds = 0.5;

export type StepSize = 'short' | 'long';
export type StepDirection = 'back' | 'forward';

/** The settings' defaults, in seconds (spec #12, Settings). */
const defaultStepSeconds = { short: 5, long: 30 } as const;
const stepSettings = { short: 'shortStep', long: 'longStep' } as const;

/** What the player reported about the current Lesson since its last `load`. */
interface Playback {
  /** Whether the Lesson is playing. */
  readonly playing: boolean;
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

function pressPlayText(lesson: Lesson): string {
  return `VS Code did not let “${lesson.title}” start by itself. Press play in the player to start it.`;
}

export function createFollowAlong(ports: Ports): FollowAlong {
  const { player, storage, clock, ui, logger, config } = ports;

  let current: CurrentLesson | undefined;
  /** The open Course's Progress. */
  let progress: ProgressRecorder | undefined;
  /** The next save while the Lesson plays. */
  let saveTimer: Disposable | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
  /** What the player last said about the current Lesson; starts again with every `load`. */
  let playback = freshPlayback(false);

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
    };
    player.send(command);
    playback = freshPlayback(command.autoplay);
  }

  /** Saves every 5 s from now on, until the Lesson stops playing. */
  function startSaving(): void {
    saveTimer ??= clock.schedule(saveIntervalMs, () => {
      saveTimer = undefined;
      void progress?.save();
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

  /** The Lesson the player shows now, if `event` is about it and not a late one about the last. */
  function shownLesson(event: { readonly lessonId: string }): CurrentLesson | undefined {
    return event.lessonId === current?.lesson.id ? current : undefined;
  }

  function onPlayerEvent(event: PlayerEvent): void {
    switch (event.type) {
      case 'ready':
        playerReady = true;
        logger.log({
          level: 'debug',
          message: `Player ready (AAC ${event.aacSupported ? 'supported' : 'not supported'})`,
        });
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
        if (shown.engaged) {
          void progress?.save();
        }
        break;
      }
      case 'played': {
        const shown = shownLesson(event);
        if (shown !== undefined) {
          // Also ends a run of refusals: the player did what it was asked.
          playback = { ...freshPlayback(false), playing: true };
          shown.engaged = true;
          startSaving();
        }
        break;
      }
      case 'ended':
        if (shownLesson(event) !== undefined) {
          playback = freshPlayback(false);
          stopSaving();
        }
        break;
      case 'timeUpdate': {
        const shown = shownLesson(event);
        if (shown !== undefined) {
          shown.position = event.position;
          shown.duration = event.duration;
          if (shown.engaged) {
            progress?.record(shown.lesson.id, event.position, event.duration);
          }
        }
        break;
      }
      case 'seeked': {
        // A seek is the learner moving the playhead, playing or not: it counts, and saves now.
        // The player's timeUpdate at the new position comes before it (HTML seek steps). One seek
        // is FollowAlong's own: the one that puts a Lesson that has not played yet at its start.
        const shown = shownLesson(event);
        const isStartSeek =
          shown !== undefined &&
          !shown.engaged &&
          Math.abs(shown.position - shown.startAt) < startSeekToleranceSeconds;
        if (shown !== undefined && !isStartSeek) {
          shown.engaged = true;
          progress?.record(shown.lesson.id, shown.position, shown.duration);
          void progress?.save();
        }
        break;
      }
    }
  }

  const subscriptions: Disposable[] = [player.onEvent(onPlayerEvent)];

  function dispose(): void {
    saveTimer?.dispose();
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  }

  /** The open Course: what the Lesson tree shows, and where `playLesson` looks up a Lesson. */
  let openedCourse: Course | undefined;

  /** The learner leaves the current Lesson (another Lesson, another Course, the window closes). */
  function leaveCurrent(): Promise<void> {
    stopSaving();
    // From now on its late events are ignored, so none is recorded into the next Course.
    current = undefined;
    // Also waits for a save still under way, such as the one of the Lesson before.
    return progress?.save() ?? Promise.resolve();
  }

  /** Shows `lesson` in the player beside the code, and loads it as soon as the player can. */
  function play(course: Course, lesson: Lesson, startAt: number, autoplay: boolean): void {
    current = {
      lesson,
      startAt,
      autoplay,
      engaged: false,
      position: startAt,
      duration: 0,
    };
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
   * Opens a Course folder: its Lessons in the tree, and the last Lesson played (paused, 5 s before
   * its position) or else the first Lesson, which plays unless the workspace is being restored.
   */
  async function open(folder: string, restoring: boolean): Promise<void> {
    let course: Course;
    try {
      course = buildCourse(await readFolderListing(ports, folder, basename(folder)));
    } catch (error) {
      if (FileSystemError.is(error, 'notFound')) {
        ui.showMessage({
          severity: 'error',
          text: `FollowAlong cannot open “${basename(folder)}”: the folder is missing.`,
        });
        if (restoring) {
          // Said once: the next start of this workspace does not say it again.
          await storage.workspace.set(openCourseKey, undefined);
        }
        return;
      }
      throw error;
    }
    // The Lesson playing now is left only once the new Course can be opened.
    await leaveCurrent();
    openedCourse = course;
    const inOrder = lessonsInOrder(course);
    const first = inOrder[0];
    if (first === undefined) {
      const text = `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(folder)}”. If the Course is zipped, extract it first.`;
      ui.showLessonTree({ message: text, nodes: [] });
      ui.showMessage({ severity: 'warning', text });
      // A video already playing keeps playing (ADR 0007), but it is no Lesson of the open Course.
      current = undefined;
      progress = undefined;
      return;
    }
    progress = await openProgress(folder, ports);
    await storage.workspace.set(openCourseKey, folder);
    ui.showLessonTree(buildLessonTree(course));
    logger.log({ level: 'info', message: `Opened Course ${folder}` });
    const saved = progress.current();
    const last = inOrder.find((lesson) => lesson.id === saved.last?.lessonId);
    if (last === undefined) {
      // A Lesson the learner did not ask for in this session does not start by itself.
      play(course, first, 0, !restoring);
    } else {
      // Back where the learner left off, paused: no autoplay, no prompt (spec #12, Resume).
      play(course, last, resumePosition(saved, last.id), false);
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
    const value = config.get(stepSettings[size]);
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : defaultStepSeconds[size];
  }

  /** Plays a Lesson of the open Course, by its id, from 5 s before where the learner left it. */
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
    void leaveCurrent();
    const saved = progress?.current();
    play(course, lesson, saved === undefined ? 0 : resumePosition(saved, lesson.id), true);
  }

  /** Opens run one after another, so the one asked for last is the Course left open. */
  let opening: Promise<void> = Promise.resolve();
  function openInTurn(folder: string, restoring: boolean): Promise<void> {
    const next = opening.then(() => open(folder, restoring));
    opening = next.catch(() => undefined);
    return next;
  }

  return {
    openCourse(folder) {
      return openInTurn(folder, false);
    },
    async restoreCourse() {
      const folder = storage.workspace.get(openCourseKey);
      if (typeof folder === 'string') {
        await openInTurn(folder, true);
      }
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
      playback = { ...playback, awaitingPlayAnswer: !playback.playing };
      player.send({ type: playback.playing ? 'pause' : 'play' });
    },
    async close() {
      // An open under way leaves its Lesson and saves it first; then this window's Lesson.
      await opening;
      await leaveCurrent();
      dispose();
    },
    seekStep(size, direction) {
      if (!hasPlayableLesson('Seek step')) {
        return;
      }
      const seconds = stepSeconds(size);
      player.send({ type: 'seekBy', seconds: direction === 'back' ? -seconds : seconds });
    },
    dispose,
  };
}
