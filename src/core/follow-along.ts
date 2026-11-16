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
  /** The play/pause command: pauses the Lesson if the player reports it playing, else plays it. */
  playPause(): void;
  /** Lists the open Course's Lessons by Section in a quick pick, and plays the one picked. */
  goToLesson(): Promise<void>;
  dispose(): void;
}

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
  const { player, storage, ui, logger } = ports;

  /** The Lesson the player should show. */
  let current: Lesson | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
  /** What the player last said about the current Lesson; starts again with every `load`. */
  let playback = freshPlayback(false);

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
          playback = { ...freshPlayback(false), playing: event.type === 'played' };
        }
        break;
      case 'userInteracted':
        ui.returnFocus();
        break;
      case 'timeUpdate':
        break;
    }
  }

  const subscriptions: Disposable[] = [player.onEvent(onPlayerEvent)];

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
      if (current === undefined) {
        ui.showMessage({
          severity: 'info',
          text: 'FollowAlong: no Lesson is open. Open a Course first.',
        });
        return;
      }
      if (!playerReady) {
        // The page is still starting: it takes no command yet, and it plays the Lesson on `ready`.
        logger.log({ level: 'debug', message: 'Play/pause ignored: the player is not ready yet.' });
        return;
      }
      playback = { ...playback, awaitingPlayAnswer: !playback.playing };
      player.send({ type: playback.playing ? 'pause' : 'play' });
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
