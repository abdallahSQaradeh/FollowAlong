/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import { buildCourse, lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { FileSystemError, type Disposable, type Ports } from './ports.js';
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
  playing: boolean;
  /** Where the player last reported the playhead, and the Lesson's length. */
  position: number;
  duration: number;
}

/**
 * How close to the start position a seek lands when it is the one that applies `startAt` (the
 * player moves a WebM seek onto the first buffered frame, under 0.1 s away; ADR 0006).
 */
const startSeekToleranceSeconds = 0.5;

export function createFollowAlong(ports: Ports): FollowAlong {
  const { player, storage, clock, ui, logger } = ports;

  let current: CurrentLesson | undefined;
  /** The open Course's Progress. */
  let progress: ProgressRecorder | undefined;
  /** The next save while the Lesson plays. */
  let saveTimer: Disposable | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
  /** Set by a `load` with autoplay, until the Lesson plays or pauses. */
  let awaitingAutoplay = false;

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
    awaitingAutoplay = command.autoplay;
  }

  /** Saves every 5 s from now on, until the Lesson stops playing. */
  function startSaving(): void {
    saveTimer ??= clock.schedule(saveIntervalMs, () => {
      saveTimer = undefined;
      void progress?.save();
      if (current?.playing === true) {
        startSaving();
      }
    });
  }

  /** The Lesson stopped playing (paused, ended, failed or replaced): no more saves on the clock. */
  function stopPlaying(shown: CurrentLesson): void {
    shown.playing = false;
    saveTimer?.dispose();
    saveTimer = undefined;
  }

  /** Whether `event` is about the Lesson the player shows now, not a late one about the last. */
  function isCurrent(event: { readonly lessonId: string }): CurrentLesson | undefined {
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
        const shown = isCurrent(event);
        if (shown !== undefined) {
          // The player posts nothing more for a failed Lesson (ADR 0003), not even a pause.
          stopPlaying(shown);
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong could not play “${shown.lesson.title}”: ${event.message}`,
          });
        }
        break;
      }
      case 'paused': {
        const shown = isCurrent(event);
        if (shown === undefined) {
          break;
        }
        // A pause before the Lesson ever played, not by the learner: VS Code refused autoplay.
        // Without a word the learner would face a stopped video and not know why.
        if (awaitingAutoplay && !event.byUser) {
          ui.showMessage({
            severity: 'info',
            text: `VS Code did not let “${shown.lesson.title}” start by itself. Press play in the player to start it.`,
          });
        }
        awaitingAutoplay = false;
        stopPlaying(shown);
        if (shown.engaged) {
          void progress?.save();
        }
        break;
      }
      case 'played': {
        const shown = isCurrent(event);
        if (shown !== undefined) {
          awaitingAutoplay = false;
          shown.engaged = true;
          shown.playing = true;
          startSaving();
        }
        break;
      }
      case 'ended':
        if (isCurrent(event) !== undefined) {
          awaitingAutoplay = false;
        }
        break;
      case 'timeUpdate': {
        const shown = isCurrent(event);
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
        const shown = isCurrent(event);
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
    const left = current;
    if (left === undefined) {
      return Promise.resolve();
    }
    stopPlaying(left);
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
      playing: false,
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

  return {
    openCourse(folder) {
      return open(folder, false);
    },
    async restoreCourse() {
      const folder = storage.workspace.get(openCourseKey);
      if (typeof folder === 'string') {
        await open(folder, true);
      }
    },
    playLesson(lessonId) {
      const course = openedCourse;
      const lesson =
        course && lessonsInOrder(course).find((candidate) => candidate.id === lessonId);
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
    },
    async close() {
      await leaveCurrent();
      dispose();
    },
    dispose,
  };
}
