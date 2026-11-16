/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import { buildCourse, lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { FileSystemError, type Disposable, type Ports } from './ports.js';
import { openCourseData, type CourseData } from './course-data.js';
import { buildLessonTree } from './lesson-tree.js';
import {
  newResource,
  noResources,
  resourcePath,
  resourcesFile,
  withResource,
  type ResourcesData,
} from './resources.js';
import { readFolderListing } from './folder-listing.js';

export interface FollowAlong {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** Plays a Lesson of the open Course, by its id, beside the code. */
  playLesson(lessonId: string): void;
  /** Attaches a file, from anywhere on disk, as a Resource of a Lesson of the open Course. */
  attachResource(lessonId: string, absolutePath: string): Promise<void>;
  /** Opens a Resource of the open Course, by its tree id, in a tab beside the code. */
  openResource(resourceId: string): Promise<void>;
  dispose(): void;
}

export function createFollowAlong(ports: Ports): FollowAlong {
  const { player, storage, ui, resourceOpener, logger } = ports;

  /** The Lesson the player should show. */
  let current: Lesson | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
  /** Set by a `load` with autoplay, until the Lesson plays or pauses. */
  let awaitingAutoplay = false;

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
    awaitingAutoplay = command.autoplay;
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
        // A pause before the Lesson ever played, not by the learner: VS Code refused autoplay.
        // Without a word the learner would face a stopped video and not know why.
        if (event.lessonId === current?.id) {
          if (awaitingAutoplay && !event.byUser) {
            ui.showMessage({
              severity: 'info',
              text: `VS Code did not let “${current.title}” start by itself. Press play in the player to start it.`,
            });
          }
          awaitingAutoplay = false;
        }
        break;
      case 'played':
      case 'ended':
        if (event.lessonId === current?.id) {
          awaitingAutoplay = false;
        }
        break;
      case 'timeUpdate':
        break;
    }
  }

  const subscriptions: Disposable[] = [player.onEvent(onPlayerEvent)];

  /** The open Course: what the Lesson tree shows, and where `playLesson` looks up a Lesson. */
  let openedCourse: Course | undefined;
  /** The open Course's Course data, and the Resources read from it. */
  let courseData: CourseData | undefined;
  let resources: ResourcesData = noResources;
  /** Attaches run one at a time, so two quick attaches cannot overwrite each other. */
  let attaching: Promise<unknown> = Promise.resolve();

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

  /** The Course's Resources; a Course whose file cannot be read still opens, without them. */
  async function readResources(data: CourseData, folder: string): Promise<ResourcesData> {
    try {
      return (await data.read(resourcesFile)) ?? noResources;
    } catch (error) {
      logger.log({
        level: 'warn',
        message: `Could not read the Resources of ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return noResources;
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
      courseData = openCourseData(folder, ports);
      resources = await readResources(courseData, folder);
      const first = lessonsInOrder(course)[0];
      if (first === undefined) {
        const text = `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(folder)}”. If the Course is zipped, extract it first.`;
        ui.showLessonTree({ message: text, nodes: [] });
        ui.showMessage({ severity: 'warning', text });
        return;
      }
      ui.showLessonTree(buildLessonTree(course, resources));
      logger.log({ level: 'info', message: `Opened Course ${folder}` });
      play(course, first);
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
      play(course, lesson);
    },
    attachResource(lessonId, absolutePath) {
      const course = openedCourse;
      const data = courseData;
      if (course === undefined || data === undefined) {
        logger.log({ level: 'warn', message: `Cannot attach to ${lessonId}: no Course is open.` });
        return Promise.resolve();
      }
      if (!lessonsInOrder(course).some((lesson) => lesson.id === lessonId)) {
        logger.log({
          level: 'warn',
          message: `Cannot attach to ${lessonId}: it is not a Lesson of the open Course.`,
        });
        return Promise.resolve();
      }
      const attach = async (): Promise<void> => {
        // Re-read first: another window may have attached to this Course since it was opened.
        const stored = (await data.read(resourcesFile)) ?? noResources;
        const next = withResource(stored, lessonId, newResource(course.folder, absolutePath));
        await data.write(resourcesFile, next);
        logger.log({ level: 'info', message: `Attached ${absolutePath} to ${lessonId}` });
        if (openedCourse === course) {
          resources = next;
          ui.showLessonTree(buildLessonTree(course, resources));
        }
      };
      const done = attaching.then(attach, attach);
      attaching = done.catch(() => undefined);
      return done;
    },
    async openResource(resourceId) {
      const course = openedCourse;
      const record = Object.values(resources.lessons)
        .flat()
        .find((candidate) => candidate.id === resourceId);
      if (course === undefined || record === undefined) {
        logger.log({
          level: 'warn',
          message: `Cannot open ${resourceId}: it is not a Resource of the open Course.`,
        });
        return;
      }
      await resourceOpener.openFile(resourcePath(course.folder, record));
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
