/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import { buildCourse, lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { FileSystemError, type Disposable, type Ports } from './ports.js';
import { openCourseData, type CourseData } from './course-data.js';
import { buildLessonPicker } from './lesson-picker.js';
import { buildLessonTree } from './lesson-tree.js';
import {
  findResource,
  newResource,
  noResources,
  resourcePath,
  resourcesFile,
  resourcesFileExists,
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
  /** The play/pause command: pauses the Lesson if the player reports it playing, else plays it. */
  playPause(): void;
  /**
   * The step commands: moves the playhead back or forward by the short or the long step, as the
   * `followalong.shortStep` and `followalong.longStep` settings are when the command runs.
   */
  seekStep(size: StepSize, direction: StepDirection): void;
  /** The speed commands: moves the playback rate one rung up or down the speed ladder. */
  speedStep(direction: SpeedDirection): void;
  /** The next Lesson in Course order, across Sections. */
  nextLesson(): void;
  /** The previous Lesson in Course order, across Sections. */
  previousLesson(): void;
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
  const { player, storage, ui, logger, config } = ports;

  /** The Lesson the player should show. */
  let current: Lesson | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
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
  }

  function onPlayerEvent(event: PlayerEvent): void {
    switch (event.type) {
      case 'ready':
        playerReady = true;
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
          playback = { ...freshPlayback(false), playing: event.type === 'played' };
          if (event.type === 'ended') {
            offerNextLesson();
          }
        }
        break;
      case 'nextClicked':
        if (event.lessonId === current?.id) {
          moveToLesson(1);
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
      case 'timeUpdate':
        break;
    }
  }

  /**
   * The Lesson has ended: the player stops on its last frame and, when a Lesson follows in Course
   * order, shows "Next: <title>". The core never loads it by itself (spec #12, story 50); that is
   * the learner's click on the overlay, or `nextLesson`.
   */
  function offerNextLesson(): void {
    const lessons = openedCourse === undefined ? [] : lessonsInOrder(openedCourse);
    const next = lessons[lessons.findIndex((lesson) => lesson.id === current?.id) + 1];
    if (next !== undefined) {
      player.send({ type: 'showNext', title: next.title });
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
    ui.selectLesson(lesson.id);
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

  /**
   * Plays the Lesson `offset` places from the current one in Course order, if there is one. The
   * current Lesson is not in the open Course when the learner opened a Course with no Lessons
   * after it: its player still shows the old Lesson, but there is no Lesson to move from.
   */
  function moveToLesson(offset: number): void {
    const course = openedCourse;
    const lessons = course === undefined ? [] : lessonsInOrder(course);
    const here = lessons.findIndex((lesson) => lesson.id === current?.id);
    if (course === undefined || here === -1) {
      ui.showMessage({
        severity: 'info',
        text: 'FollowAlong: no Lesson is open. Open a Course first.',
      });
      return;
    }
    const target = lessons[here + offset];
    if (target !== undefined) {
      play(course, target);
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
      // Read first, then switch, so no click sees one Course's Resources next to another's folder.
      const data = openCourseData(folder, ports);
      const stored = await readResources(data, folder);
      openedCourse = course;
      courseData = data;
      resources = stored;
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
        const read = await data.read(resourcesFile);
        if (read === undefined && (await resourcesFileExists(ports.fileSystem, course.folder))) {
          // The file is there but was ignored (damaged, or from a newer FollowAlong): writing
          // would replace data the learner, or a newer version, still needs.
          logger.log({
            level: 'warn',
            message: `Not attaching ${absolutePath}: the Resources file of ${course.folder} is damaged or from a newer version, and was left as it is.`,
          });
          ui.showMessage({
            severity: 'warning',
            text: "FollowAlong can't update this Course's Resources file (it is damaged or from a newer version). Nothing was changed.",
          });
          return;
        }
        const stored = read ?? noResources;
        const next = withResource(stored, lessonId, newResource(course.folder, absolutePath));
        await data.write(resourcesFile, next);
        logger.log({ level: 'info', message: `Attached ${absolutePath} to ${lessonId}` });
        // The Course may have been opened again while this attach was writing.
        if (openedCourse?.folder === course.folder) {
          resources = next;
          ui.showLessonTree(buildLessonTree(openedCourse, resources));
        }
      };
      const done = attaching.then(attach, attach);
      attaching = done.catch(() => undefined);
      return done;
    },
    async openResource(resourceId) {
      const course = openedCourse;
      const record = findResource(resources, resourceId);
      if (course === undefined || record === undefined) {
        logger.log({
          level: 'warn',
          message: `Cannot open ${resourceId}: it is not a Resource of the open Course.`,
        });
        return;
      }
      const path = resourcePath(course.folder, record);
      try {
        await ui.openResource({ kind: 'file', path });
      } catch (error) {
        logger.log({
          level: 'warn',
          message: `Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`,
        });
        ui.showMessage({
          severity: 'error',
          text: `FollowAlong could not open “${basename(path)}”. Is the file still there?`,
        });
      }
    },
    playPause() {
      if (!hasPlayableLesson('Play/pause')) {
        return;
      }
      playback = { ...playback, awaitingPlayAnswer: !playback.playing };
      player.send({ type: playback.playing ? 'pause' : 'play' });
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
    nextLesson() {
      moveToLesson(1);
    },
    previousLesson() {
      moveToLesson(-1);
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
