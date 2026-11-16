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

export interface FollowAlong {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** Plays a Lesson of the open Course, by its id, beside the code. */
  playLesson(lessonId: string): void;
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
  /** The length the player last reported. */
  duration: number;
}

export function createFollowAlong(ports: Ports): FollowAlong {
  const { player, storage, ui, logger } = ports;

  let current: CurrentLesson | undefined;
  /** The open Course's Progress. */
  let progress: ProgressRecorder | undefined;
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
          shown.duration = event.duration;
          if (shown.engaged) {
            progress?.record(shown.lesson.id, event.position, event.duration);
          }
        }
        break;
      }
      case 'seeked':
        break;
    }
  }

  const subscriptions: Disposable[] = [player.onEvent(onPlayerEvent)];

  /** The open Course: what the Lesson tree shows, and where `playLesson` looks up a Lesson. */
  let openedCourse: Course | undefined;

  /** Shows `lesson` in the player beside the code, and loads it as soon as the player can. */
  function play(course: Course, lesson: Lesson, startAt: number, autoplay: boolean): void {
    current = { lesson, startAt, autoplay, engaged: false, playing: false, duration: 0 };
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
      const inOrder = lessonsInOrder(course);
      const first = inOrder[0];
      if (first === undefined) {
        const text = `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(folder)}”. If the Course is zipped, extract it first.`;
        ui.showLessonTree({ message: text, nodes: [] });
        ui.showMessage({ severity: 'warning', text });
        return;
      }
      progress = await openProgress(folder, ports);
      ui.showLessonTree(buildLessonTree(course));
      logger.log({ level: 'info', message: `Opened Course ${folder}` });
      const saved = progress.current();
      const last = inOrder.find((lesson) => lesson.id === saved.last?.lessonId);
      if (last === undefined) {
        play(course, first, 0, true);
      } else {
        // Back where the learner left off, paused: no autoplay, no prompt (spec #12, Resume).
        play(course, last, resumePosition(saved, last.id), false);
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
      play(course, lesson, 0, true);
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
