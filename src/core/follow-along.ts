/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import { buildCourse, lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { FileSystemError, type Ports } from './ports.js';
import {
  fallbackRoot,
  openCourseData,
  UnreadableCourseDataError,
  type CourseData,
} from './course-data.js';
import { buildCoursePicker } from './course-picker.js';
import { scanCourses } from './course-scanner.js';
import { addCoursesRoot, playerFolders, readCoursesRoots } from './courses-roots.js';
import { buildLessonPicker } from './lesson-picker.js';
import { buildLessonTree } from './lesson-tree.js';
import {
  createLoadedLesson,
  noLessonText,
  type SpeedDirection,
  type StepDirection,
  type StepSize,
} from './loaded-lesson.js';
import type { StatusBarCommand } from './status-bar.js';
import {
  findResource,
  newResource,
  noResources,
  resourcePath,
  resourceTarget,
  resourcesFile,
  resourcesFileExists,
  withResource,
  type ResourcesData,
} from './resources.js';
import { readFolderListing } from './folder-listing.js';
import { openProgress, resumePosition, type ProgressRecorder } from './progress.js';
import { createTerminalKeysOffer } from './terminal-keys.js';

/** Workspace storage key: the folder of the Course open in this workspace (story 21). */
const openCourseKey = 'openCourse';

export interface FollowAlong {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** Opens the Course that was open in this workspace, if any, paused where the learner left it. */
  restoreCourse(): Promise<void>;
  /** Plays a Lesson of the open Course, by its id, beside the code. */
  playLesson(lessonId: string): void;
  /** Attaches a file, from anywhere on disk, as a Resource of a Lesson of the open Course. */
  attachResource(lessonId: string, absolutePath: string): Promise<void>;
  /**
   * The attach command from the chord or the Command Palette: asks for a file and attaches it to
   * the Loaded Lesson when the command runs. The Lesson keeps playing meanwhile.
   */
  attachToLoadedLesson(): Promise<void>;
  /** Opens a Resource of the open Course, by its tree id, in a tab beside the code. */
  openResource(resourceId: string): Promise<void>;
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
  /**
   * A click on a status bar item: runs the command the item names. The speed item moves the
   * playback rate one rung up the speed ladder, and from the top rung back to the bottom one,
   * so repeated clicks go round.
   */
  statusBarClick(command: StatusBarCommand): void;
  /** The next Lesson in Course order, across Sections. */
  nextLesson(): void;
  /** The previous Lesson in Course order, across Sections. */
  previousLesson(): void;
  /**
   * Lists the open Course's Lessons by Section in a quick pick, and plays the one picked. With no
   * Course open, it opens the Course picker instead.
   */
  goToLesson(): Promise<void>;
  /** The Course picker: lists the Courses under the Courses roots, and opens the one picked. */
  pickCourse(): Promise<void>;
  /** The window is closing: saves Progress, then stops. */
  close(): Promise<void>;
  /** Stops at once, without saving (tests use it as a crash). */
  dispose(): void;
}

export type { SpeedDirection, StepDirection, StepSize } from './loaded-lesson.js';

export function createFollowAlong(ports: Ports): FollowAlong {
  const { storage, ui, logger, config } = ports;

  /** The open Course: what the Lesson tree shows, and where `playLesson` looks up a Lesson. */
  let openedCourse: Course | undefined;
  /** The open Course's Course data, and the Resources read from it. */
  let courseData: CourseData | undefined;
  let resources: ResourcesData = noResources;
  /** The open Course's Progress. */
  let progress: ProgressRecorder | undefined;
  /** Attaches run one at a time, so two quick attaches cannot overwrite each other. */
  let attaching: Promise<unknown> = Promise.resolve();

  /** The Lesson the player holds, and the playback commands. */
  const loaded = createLoadedLesson(ports, {
    progress: () => progress,
    lessonAfter: (lesson) => lessonBeside(lesson, 1)?.target,
    nextClicked: (next) => {
      playLesson(next.id);
    },
  });

  /**
   * The Lesson `offset` places from `lesson` in the open Course's Course order. `undefined` when
   * `lesson` is not one of the open Course's Lessons: there is no place to count from. `target`
   * is `undefined` beyond either end of the Course.
   */
  function lessonBeside(
    lesson: Lesson | undefined,
    offset: number,
  ): { readonly target: Lesson | undefined } | undefined {
    const lessons = openedCourse === undefined ? [] : lessonsInOrder(openedCourse);
    // The Lesson itself, not its id: another Course can hold a Lesson with the same id.
    const here = lesson === undefined ? -1 : lessons.indexOf(lesson);
    return here === -1 ? undefined : { target: lessons[here + offset] };
  }

  /** Offers, once, to add the one-press commands to the terminal's skip-shell setting. */
  const offerTerminalKeys = createTerminalKeysOffer(ports);

  /** Shows `lesson` in the player beside the code, and loads it as soon as the player can. */
  function play(course: Course, lesson: Lesson, startAt: number, autoplay: boolean): void {
    logger.log({ level: 'info', message: `Playing ${lesson.id} of ${course.folder}` });
    ui.selectLesson(lesson.id);
    loaded.load(lesson, {
      startAt,
      autoplay,
      resourceRoots: playerFolders(
        readCoursesRoots(config).roots,
        course.folder,
        fallbackRoot(storage.folder),
      ),
    });
    offerTerminalKeys();
  }

  /**
   * Attaches a file to a Lesson of `course`, after any attach still under way. It writes into that
   * Course's data even if the learner has opened another Course since, and shows it in the tree
   * only if that Course is still the one open.
   */
  function attachInTurn(
    course: Course,
    data: CourseData,
    lessonId: string,
    absolutePath: string,
  ): Promise<void> {
    /** The Resources file is there but cannot be used: writing would replace what it holds. */
    const refuse = (): void => {
      logger.log({
        level: 'warn',
        message: `Not attaching ${absolutePath}: the Resources file of ${course.folder} is damaged or from a newer version, and was left as it is.`,
      });
      ui.showMessage({
        severity: 'warning',
        text: "FollowAlong can't update this Course's Resources file (it is damaged or from a newer version). Nothing was changed.",
      });
    };
    const attach = async (): Promise<void> => {
      // Re-read first: another window may have attached to this Course since it was opened.
      const read = await data.read(resourcesFile);
      if (read === undefined && (await resourcesFileExists(ports.fileSystem, course.folder))) {
        // The file is there but was ignored (damaged, or from a newer FollowAlong): writing
        // would replace data the learner, or a newer version, still needs.
        refuse();
        return;
      }
      const stored = read ?? noResources;
      const next = withResource(stored, lessonId, newResource(course.folder, absolutePath));
      try {
        await data.write(resourcesFile, next);
      } catch (error) {
        // The copy the write would replace (the fallback one, in a read-only Course) is unusable.
        if (error instanceof UnreadableCourseDataError) {
          refuse();
          return;
        }
        throw error;
      }
      logger.log({ level: 'info', message: `Attached ${absolutePath} to ${lessonId}` });
      // The Course may have been opened again, or another one opened, while this attach wrote.
      if (openedCourse?.folder === course.folder) {
        resources = next;
        ui.showLessonTree(buildLessonTree(openedCourse, resources));
      }
    };
    const done = attaching.then(attach, attach);
    attaching = done.catch(() => undefined);
    return done;
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
   * Opens a Course folder: its Lessons in the tree, and the last Lesson played (paused, 5 s before
   * its position) or else the first Lesson, which plays unless the workspace is being restored.
   */
  async function open(folder: string, restoring: boolean, request: number): Promise<void> {
    /** Whether the learner asked for another Course since this one: then this open is dropped. */
    const superseded = (): boolean => {
      if (request === openRequests) {
        return false;
      }
      logger.log({
        level: 'info',
        message: `Not opening ${folder}: another Course was asked for since.`,
      });
      return true;
    };
    if (superseded()) {
      return;
    }
    let course: Course;
    try {
      course = buildCourse(await readFolderListing(ports, folder, basename(folder)));
    } catch (error) {
      // A later open replaces this one: what this folder failed with no longer matters.
      if (error instanceof FileSystemError && superseded()) {
        return;
      }
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
    if (superseded()) {
      return;
    }
    // From leaving the Lesson that plays to playing the new Course's, no other Lesson may start:
    // it would be loaded from the Course being left and recorded into the new one's Progress.
    switching = true;
    try {
      // The Lesson playing now is left only once the new Course can be opened.
      const hadLesson = loaded.lesson() !== undefined;
      await loaded.leave();
      // Read first, then switch, so no click sees one Course's Resources next to another's folder.
      const data = openCourseData(folder, ports);
      const stored = await readResources(data, folder);
      const inOrder = lessonsInOrder(course);
      const first = inOrder[0];
      const recorder = first === undefined ? undefined : await openProgress(folder, ports);
      openedCourse = course;
      courseData = data;
      resources = stored;
      progress = recorder;
      if (first === undefined || recorder === undefined) {
        const text = `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(folder)}”. If the Course is zipped, extract it first.`;
        ui.showLessonTree({ message: text, nodes: [] });
        ui.showMessage({ severity: 'warning', text });
        // The player still shows the Lesson it had, but this Course has none to offer: the
        // commands and the status bar items follow the Course the learner opened.
        // The video would play on with every control gone, so it is stopped first.
        loaded.unload(hadLesson);
        return;
      }
      await storage.workspace.set(openCourseKey, folder);
      ui.showLessonTree(buildLessonTree(course, resources));
      logger.log({ level: 'info', message: `Opened Course ${folder}` });
      const saved = recorder.current();
      const last = inOrder.find((lesson) => lesson.id === saved.last?.lessonId);
      if (last === undefined) {
        // A Lesson the learner did not ask for in this session does not start by itself.
        play(course, first, 0, !restoring);
      } else {
        // Back where the learner left off, paused: no autoplay, no prompt (spec #12, Resume).
        play(course, last, resumePosition(saved, last.id), false);
      }
    } finally {
      switching = false;
    }
  }

  /** Plays a Lesson of the open Course, by its id, from 5 s before where the learner left it. */
  function playLesson(lessonId: string): void {
    if (switching) {
      logger.log({
        level: 'info',
        message: `Not playing ${lessonId}: another Course is opening.`,
      });
      return;
    }
    const course = openedCourse;
    const lesson = course && lessonsInOrder(course).find((candidate) => candidate.id === lessonId);
    if (course === undefined || lesson === undefined) {
      logger.log({
        level: 'warn',
        message: `Cannot play ${lessonId}: it is not a Lesson of the open Course.`,
      });
      return;
    }
    void loaded.leave();
    const saved = progress?.current();
    play(course, lesson, saved === undefined ? 0 : resumePosition(saved, lesson.id), true);
  }

  /** The Courses roots setting entries, and the roots, the learner was told about in this window. */
  const warnedRoots = new Set<string>();
  const warnedUnreadable = new Set<string>();
  /**
   * Opens run one after another, so the one asked for last is the Course left open. An open that
   * a later one superseded while it waited, or while it read its folder, is dropped when it gets
   * there (ADR 0022): a slow drive never shows its Course after the learner picked another.
   */
  let opening: Promise<void> = Promise.resolve();
  /** How many opens were asked for: the number of the latest, which is the one that wins. */
  let openRequests = 0;
  /** Set while an open has left the Lesson that played and has not played the new Course yet. */
  let switching = false;
  function openInTurn(folder: string, restoring: boolean): Promise<void> {
    openRequests += 1;
    const request = openRequests;
    const next = opening.then(() => open(folder, restoring, request));
    opening = next.catch(() => undefined);
    return next;
  }

  /**
   * Plays the Lesson `offset` places from the Loaded Lesson in Course order, if there is one. With
   * no Lesson loaded (none yet, the player was closed, or the open Course has no Lessons) there is
   * no Lesson to move from.
   */
  function moveToLesson(offset: number): void {
    const beside = lessonBeside(loaded.lesson(), offset);
    if (beside === undefined) {
      ui.showMessage({ severity: 'info', text: noLessonText });
      return;
    }
    if (beside.target !== undefined) {
      // A Lesson switch like any other: the Lesson left is saved, the next resumes 5 s back.
      playLesson(beside.target.id);
    }
  }

  /**
   * Tells the learner, once per window, about setting entries that are not a full path: they are
   * skipped, because a path such as `.` resolves against whatever folder VS Code runs in.
   */
  function warnNotAbsolute(entries: readonly string[]): void {
    const unwarned = entries.filter((entry) => !warnedRoots.has(entry));
    if (unwarned.length === 0) {
      return;
    }
    for (const entry of unwarned) {
      warnedRoots.add(entry);
    }
    const names = unwarned.map((entry) => `“${entry}”`).join(', ');
    const root = unwarned.length === 1 ? 'root' : 'roots';
    ui.showMessage({
      severity: 'warning',
      text: `FollowAlong skips the Courses ${root} ${names}: a Courses root must be a full path, such as D:\\Learning.`,
    });
  }

  /** The Course picker. */
  async function pickCourse(): Promise<void> {
    const { roots, notAbsolute } = readCoursesRoots(config);
    warnNotAbsolute(notAbsolute);
    const scan = await scanCourses(ports, roots);
    // Once per window: a drive that stays unplugged would otherwise be named at every open.
    for (const root of scan.unreadableRoots.filter((unread) => !warnedUnreadable.has(unread))) {
      warnedUnreadable.add(root);
      ui.showMessage({
        severity: 'warning',
        text: `FollowAlong can't read the Courses root “${root}”. Is the folder or drive still there?`,
      });
    }
    const intent = await ui.pick(
      buildCoursePicker({ hasRoots: roots.length > 0, courses: scan.courses }),
    );
    switch (intent?.type) {
      case 'openCourse':
        await openInTurn(intent.folder, false);
        break;
      case 'addCoursesRoot':
        // The learner added a root to pick a Course from it: show the list again, with its Courses.
        if (await chooseCoursesRoot()) {
          await pickCourse();
        }
        break;
      case undefined:
        break;
    }
  }

  /**
   * Asks for a folder and adds it to the Courses roots, after the ones already there. Resolves
   * with whether the learner chose one (it may already have been a root).
   */
  async function chooseCoursesRoot(): Promise<boolean> {
    const root = await ui.chooseFolder({ title: 'Add Courses root', openLabel: 'Add' });
    if (root === undefined) {
      return false;
    }
    if (await addCoursesRoot(config, root)) {
      logger.log({ level: 'info', message: `Added the Courses root ${root}` });
    }
    return true;
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
    pickCourse,
    async goToLesson() {
      if (openedCourse === undefined) {
        // With no Course there is no Lesson to go to: the key opens the Course picker (story 35).
        await pickCourse();
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
      return attachInTurn(course, data, lessonId, absolutePath);
    },
    async attachToLoadedLesson() {
      // The Lesson is fixed when the learner presses the key, not when the dialog closes: the
      // learner means the Lesson they were watching, even if the next one starts meanwhile. Its
      // Course is fixed too, because another Course can hold a Lesson with the same id.
      const lesson = loaded.lesson();
      const course = openedCourse;
      const data = courseData;
      if (lesson === undefined || course === undefined || data === undefined) {
        ui.showMessage({
          severity: 'info',
          text: 'Open a Lesson first, then attach a Resource to it.',
        });
        return;
      }
      try {
        const path = await ui.pickFile();
        if (path !== undefined) {
          await attachInTurn(course, data, lesson.id, path);
        }
      } finally {
        // The dialog took keyboard focus: hand it back, also when the attach failed (ADR 0023).
        ui.returnFocus();
      }
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
        await ui.openResource(resourceTarget(path));
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
      loaded.playPause();
    },
    resumeWithoutRewind() {
      loaded.resumeWithoutRewind();
    },
    seekStep(size, direction) {
      loaded.seekStep(size, direction);
    },
    speedStep(direction) {
      loaded.speedStep(direction);
    },
    statusBarClick(command) {
      loaded.statusBarClick(command);
    },
    async close() {
      // An open under way leaves its Lesson and saves it first; then this window's Lesson.
      await opening;
      await loaded.leave();
      loaded.dispose();
    },
    nextLesson() {
      moveToLesson(1);
    },
    previousLesson() {
      moveToLesson(-1);
    },
    dispose() {
      loaded.dispose();
    },
  };
}
