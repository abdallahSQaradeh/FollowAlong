/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import { messageOf } from './logger.js';
import { createAudioCache } from './audio-cache.js';
import { rememberAutoPauseMode, toggleAutoPause } from './auto-pause-toggle.js';
import { isTyping, type DocumentEdit } from './auto-pause.js';
import { findSection, lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { FileSystemError, type Ports } from './ports.js';
import { fallbackRoot } from './course-data.js';
import { takeCourseHandOff } from './course-hand-off.js';
import { createCoursePickerCommand } from './course-picker-command.js';
import { unhideCourse } from './hidden-courses.js';
import { playerFolders, readCoursesRoots } from './courses-roots.js';
import { sameFolder } from './folder-identity.js';
import { startLessonLengthJob, type LessonLengthJob } from './lesson-length-job.js';
import { buildLessonPicker } from './lesson-picker.js';
import { buildLessonTree, type LessonTreeModel } from './lesson-tree.js';
import {
  createLoadedLesson,
  noLessonText,
  type SpeedDirection,
  type StepDirection,
  type StepSize,
} from './loaded-lesson.js';
import type { StatusBarCommand } from './status-bar.js';
import type { ZoomAction } from '../protocol/player-messages.js';
import { openResources, type ResourceStore } from './resource-store.js';
import { createResourceCommands, type ResourceCommands } from './resource-commands.js';
import { readCourse } from './folder-listing.js';
import { lessonStatus, openProgress, resumePosition, type ProgressRecorder } from './progress.js';
import { openSidecarSound, type SidecarSound } from './sidecar-sound.js';
import { recordOpened } from './recent-courses.js';
import { createTerminalKeysOffer } from './terminal-keys.js';
import { buildSpotPicker, type VideoSpot } from './video-placement.js';

/** Workspace storage key: the folder of the Course open in this workspace (story 21). */
const openCourseKey = 'openCourse';

export interface FollowAlong extends ResourceCommands {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** Opens the Course that was open in this workspace, if any, paused where the learner left it. */
  restoreCourse(): Promise<void>;
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
  /** The zoom commands: asks the player to zoom in or out, to reset, or to draw an area. */
  zoom(action: ZoomAction): void;
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
  /**
   * _Move video to…_: moves the player to another spot (ADR 0049), keeping the Lesson's time,
   * speed, play or pause, and zoom. Without `to` it asks which spot with a quick pick.
   */
  moveVideo(to?: VideoSpot): Promise<void>;
  /** Collapses the video where it is, or brings it back in the same spot (ADR 0092). */
  toggleVideo(): Promise<void>;
  /**
   * `Ctrl+'` `A` and `FollowAlong: Toggle Auto-pause`: switches `followalong.autoPause` off, or
   * back to the last mode that was on (`pause` if none), and writes nothing else (ADR 0098).
   */
  toggleAutoPause(): Promise<void>;
  /**
   * `FollowAlong: Unhide a Course…`: lists the Courses hidden from the Course picker and shows the
   * one the learner picks in it again (ADR 0072).
   */
  unhideCourse(): Promise<void>;
  /**
   * `FollowAlong: Clear audio cache`: deletes every prepared sound file of every Course, in Course
   * data and in the fallback storage, and nothing else. The sound of the Lesson that is loaded
   * stays, because the player is reading it. Says how much it deleted; resolves once done.
   */
  clearAudioCache(): Promise<void>;
  /**
   * The text of a document open in VS Code changed: auto-pause's input (spec #12, Auto-pause).
   * Cursor moves are not edits, so they never reach it.
   */
  documentEdited(edit: DocumentEdit): void;
  /**
   * `Ctrl+'` `D` and `FollowAlong: Mark done / not done`: marks the Loaded Lesson done, or, when it
   * is done already, not done (a reset, ADR 0061). Resolves once the change is saved.
   */
  toggleLessonDone(): Promise<void>;
  /** The tree's "Mark done" on a Lesson of the open Course. Resolves once the mark is saved. */
  markLessonDone(lessonId: string): Promise<void>;
  /**
   * The tree's "Mark not done" on a Lesson of the open Course: a reset, so its done mark and
   * saved position go (ADR 0061). Resolves once the change is saved.
   */
  markLessonNotDone(lessonId: string): Promise<void>;
  /**
   * Marks every Lesson of a Section of the open Course done, nested Sections included: the
   * Section's "Mark all done" in the tree. Resolves once the marks are saved.
   */
  markSectionDone(sectionId: string): Promise<void>;
  /**
   * Resets every Lesson of a Section of the open Course, nested Sections included (done marks and
   * positions go), and nothing outside it: the Section's "Reset Section" in the tree.
   * Resolves once the change is saved.
   */
  resetSection(sectionId: string): Promise<void>;
  /**
   * `FollowAlong: Reset Course progress`: asks the learner to confirm, then resets the open
   * Course's Progress: every done mark and position, and the Lesson it reopens on. Resources and
   * prepared sound are untouched. Resolves once the change is saved, or when nothing was changed.
   */
  resetCourseProgress(): Promise<void>;
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
  /** The open Course's Resources. */
  let resourceStore: ResourceStore | undefined;
  /** The open Course's Progress. */
  let progress: ProgressRecorder | undefined;
  /** The open Course's audio sidecars (ADR 0034). */
  let sidecarSound: SidecarSound | undefined;
  /** The open Course's length job, which reads its Lessons' lengths (ADR 0109). */
  let lengthJob: LessonLengthJob | undefined;
  /** Updates the open Lesson picker with the lengths known now; unset while none is open. */
  let followLengths: (() => void) | undefined;
  /** The `followalong.ffmpegPath` values the learner was told are ignored in this window. */
  const warnedFfmpegPaths = new Set<string>();
  /** The prepared sound of every Course on this machine, kept under its limit (ADR 0096). */
  const audioCache = createAudioCache(ports);
  // A lower limit takes effect at once, not at the next conversion.
  const limitWatch = config.onDidChange((affects) => {
    if (affects('audioCacheLimit')) {
      audioCache.prune();
    }
  });

  // The last auto-pause mode that was on, so the toggle can bring it back (ADR 0098).
  const modeWatch = rememberAutoPauseMode(config, storage, logger);

  /**
   * The audio sidecars and the length job of `course` replace the open Course's, which stop
   * (ADR 0034, 0109).
   */
  function openBackgroundWorkOf(course: Course): void {
    sidecarSound?.stop();
    sidecarSound = openSidecarSound(course.folder, ports, warnedFfmpegPaths, audioCache);
    lengthJob?.stop();
    lengthJob = startLessonLengthJob(course, ports, warnedFfmpegPaths, () => {
      drawTreeWith(resourceStore);
      followLengths?.();
    });
  }

  /** Stops the open Course's background work: the window closes. */
  function stopBackgroundWork(): void {
    sidecarSound?.stop();
    lengthJob?.stop();
  }

  /** What the Lesson tree shows now (as JSON), so a redraw that would change nothing is skipped. */
  let shownTree: string | undefined;

  /** Replaces the Lesson tree in the UI. */
  function drawTree(model: LessonTreeModel): void {
    shownTree = JSON.stringify(model);
    ui.showLessonTree(model);
  }

  /**
   * Draws the tree of the open Course with `store`'s Resources and what Progress knows now, not yet
   * saved included. Does nothing when the learner would see the same tree.
   */
  function drawTreeWith(store: ResourceStore | undefined): void {
    if (openedCourse === undefined || progress === undefined || store === undefined) {
      return;
    }
    const model = buildLessonTree(
      openedCourse,
      store.current(),
      progress.current(),
      store.missing(),
      lengthJob?.lengths(),
    );
    if (JSON.stringify(model) !== shownTree) {
      drawTree(model);
    }
  }

  /** Draws the open Course's tree again (ADR 0044). */
  function refreshTree(): void {
    drawTreeWith(resourceStore);
  }

  /** The Lesson the player holds, and the playback commands. */
  const loaded = createLoadedLesson(ports, {
    progress: () => progress,
    lessonAfter: (lesson) => lessonBeside(lesson, 1)?.target,
    nextClicked: (next) => {
      playLesson(next.id);
    },
    prepareSound: (lesson, request) =>
      sidecarSound === undefined
        ? Promise.reject(new Error('No Course is open.'))
        : sidecarSound.prepare(lesson, request),
    prepareSoundAhead: (lesson, pageDecodes) => {
      sidecarSound?.prepareAhead(
        lesson,
        openedCourse === undefined ? [] : lessonsInOrder(openedCourse),
        pageDecodes,
      );
    },
    progressChanged: refreshTree,
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

  /** Attach, open, detach and relink, on the open Course's Resources. */
  const resourceCommands = createResourceCommands(ports, {
    course: () => openedCourse,
    store: () => resourceStore,
    loadedLesson: () => loaded.lesson(),
    drawTreeWith,
  });

  /** The folders the player may read for `course` (ADR 0022). */
  function resourceRootsOf(course: Course): string[] {
    return playerFolders(
      readCoursesRoots(config).roots,
      course.folder,
      fallbackRoot(storage.folder),
    );
  }

  /** Shows `lesson` in the player beside the code, and loads it as soon as the player can. */
  function play(course: Course, lesson: Lesson, startAt: number, autoplay: boolean): void {
    logger.log({ level: 'info', message: `Playing ${lesson.id} of ${course.folder}` });
    ui.selectLesson(lesson.id);
    loaded.load(lesson, {
      startAt,
      autoplay,
      resourceRoots: resourceRootsOf(course),
    });
    offerTerminalKeys();
  }

  /**
   * Opens a Course folder: its Lessons in the tree, and the last Lesson played (paused, 5 s before
   * its position) or else the first Lesson, which plays unless the workspace is being restored.
   * With `video` (an absolute path, picked in the Folder browser) that Lesson plays instead, as
   * `playLesson` plays it, whatever the Course had played last.
   */
  async function open(
    folder: string,
    restoring: boolean,
    request: number,
    video?: string,
  ): Promise<void> {
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
    const playing = loaded.lesson();
    const openLesson = openedCourse === undefined ? undefined : lessonOfVideo(openedCourse, video);
    if (
      openLesson !== undefined &&
      openedCourse !== undefined &&
      sameFolder(openedCourse.folder, folder)
    ) {
      // The Course is open and the learner picked one of its videos: nothing is opened again.
      logger.log({ level: 'info', message: `Not opening ${folder}: it is the open Course.` });
      playLesson(openLesson.id);
      return;
    }
    if (
      video === undefined &&
      playing !== undefined &&
      openedCourse !== undefined &&
      sameFolder(openedCourse.folder, folder)
    ) {
      // The Course is open and its Lesson is in the player: picking it again changes nothing, so
      // the Lesson is not reloaded and the learner does not land on Lesson 1 (ADR 0041).
      logger.log({ level: 'info', message: `Not opening ${folder}: it is the open Course.` });
      ui.selectLesson(playing.id);
      loaded.reveal(resourceRootsOf(openedCourse));
      return;
    }
    let course: Course;
    try {
      course = await readCourse(ports, folder, readCoursesRoots(config).roots);
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
      const store = await openResources(folder, ports);
      const inOrder = lessonsInOrder(course);
      const first = inOrder[0];
      const recorder = first === undefined ? undefined : await openProgress(folder, ports);
      if (first === undefined || recorder === undefined) {
        openedCourse = course;
        resourceStore = store;
        progress = recorder;
        openBackgroundWorkOf(course);
        const text = `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(folder)}”. If the Course is zipped, extract it first.`;
        drawTree({ message: text, nodes: [] });
        ui.showMessage({ severity: 'warning', text });
        // The player still shows the Lesson it had, but this Course has none to offer: the
        // commands and the status bar items follow the Course the learner opened.
        // The video would play on with every control gone, so it is stopped first.
        loaded.unload(hadLesson);
        return;
      }
      // Stored before the Course counts as open: if this fails, the Course that was open still is,
      // with its tree, and no click plays this Course's Lesson by matching its id (ADR 0041).
      await storage.workspace.set(openCourseKey, folder);
      openedCourse = course;
      resourceStore = store;
      progress = recorder;
      openBackgroundWorkOf(course);
      drawTree(
        buildLessonTree(
          course,
          store.current(),
          recorder.current(),
          store.missing(),
          lengthJob?.lengths(),
        ),
      );
      logger.log({ level: 'info', message: `Opened Course ${folder}` });
      await rememberRecent(folder);
      const saved = recorder.current();
      const last = inOrder.find((lesson) => lesson.id === saved.last?.lessonId);
      const picked = lessonOfVideo(course, video);
      if (picked !== undefined) {
        // A video the learner picked plays, as a Lesson picked from the Lesson picker does.
        play(course, picked, resumePosition(saved, picked.id), true);
      } else if (last === undefined) {
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

  /** The Lesson of `course` that is the video at this absolute path, if it is one. */
  function lessonOfVideo(course: Course, video: string | undefined): Lesson | undefined {
    return video === undefined
      ? undefined
      : lessonsInOrder(course).find((lesson) => sameFolder(lesson.path, video));
  }

  /** Puts the Course first in Recent; Recent is a convenience, so a failure is only logged. */
  async function rememberRecent(folder: string): Promise<void> {
    try {
      await recordOpened(storage.global, folder);
    } catch (error) {
      logger.log({
        level: 'warn',
        message: `Could not remember ${folder} as a Recent Course: ${messageOf(error)}`,
      });
    }
  }

  /**
   * Whether a Course is being opened, in which case a command that needs a Lesson is refused with
   * one message: the tree and the status bar still show the Course being left, and a silent
   * refusal looks like a dead key.
   */
  function refusedWhileOpening(): boolean {
    if (!switching) {
      return false;
    }
    ui.showMessage({ severity: 'info', text: 'FollowAlong is opening a Course…' });
    return true;
  }

  /**
   * Plays a Lesson of the open Course, by its id, from where the start rule says (5 s before where
   * the learner left it; 0:00 for a done Lesson saved at its end), or from 0:00 with `fromStart`.
   */
  function playLesson(lessonId: string, fromStart = false): void {
    if (refusedWhileOpening()) {
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
    // The Lesson left shows where the learner left it, which is saved with it.
    refreshTree();
    const saved = progress?.current();
    const startAt = saved === undefined || fromStart ? 0 : resumePosition(saved, lesson.id);
    play(course, lesson, startAt, true);
  }

  /** _Open Course…_: the Course picker, opening what the learner picks in this window. */
  const pickCourse = createCoursePickerCommand(ports, {
    openCourseFolder: () => openedCourse?.folder,
    saveProgress: () => progress?.save() ?? Promise.resolve(),
    open: (folder, video) => openInTurn(folder, false, video),
  });
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
  function openInTurn(folder: string, restoring: boolean, video?: string): Promise<void> {
    openRequests += 1;
    const request = openRequests;
    const next = opening.then(() => open(folder, restoring, request, video));
    opening = next.catch(() => undefined);
    return next;
  }

  /**
   * Plays the Lesson `offset` places from the Loaded Lesson in Course order, if there is one. With
   * no Lesson loaded (none yet, the player was closed, or the open Course has no Lessons) there is
   * no Lesson to move from.
   */
  function moveToLesson(offset: number): void {
    if (refusedWhileOpening()) {
      return;
    }
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
   * The marking path (ADR 0061). Every change the learner makes to Progress by hand is made on
   * the recorder of the Course the command ran in (`markDone`, `reset`, `resetAll`), then shown in
   * the tree at once and saved here. The promise resolves once it is saved.
   */
  async function showAndSave(recorder: ProgressRecorder): Promise<void> {
    refreshTree();
    await recorder.save();
  }

  /** Marks Lessons done by id: a command for one Lesson calls this with one id (#29). */
  function markLessonsDone(
    recorder: ProgressRecorder,
    lessonIds: readonly string[],
  ): Promise<void> {
    recorder.markDone(lessonIds);
    return showAndSave(recorder);
  }

  /** Resets Lessons by id, and restarts the play count of the Loaded Lesson if it is one. */
  function resetLessons(recorder: ProgressRecorder, lessonIds: readonly string[]): Promise<void> {
    recorder.reset(lessonIds);
    loaded.progressReset(lessonIds);
    return showAndSave(recorder);
  }

  /**
   * Runs `change` on the Lessons of a Section of the open Course, nested Sections included. The
   * Course and its Progress are fixed when the command runs.
   */
  function changeSection(
    sectionId: string,
    what: string,
    change: (recorder: ProgressRecorder, lessonIds: readonly string[]) => Promise<void>,
  ): Promise<void> {
    if (refusedWhileOpening()) {
      return Promise.resolve();
    }
    const section = openedCourse && findSection(openedCourse, sectionId);
    if (section === undefined || progress === undefined) {
      logger.log({
        level: 'warn',
        message: `Cannot ${what} in ${sectionId}: it is not a Section of the open Course.`,
      });
      return Promise.resolve();
    }
    return change(
      progress,
      lessonsInOrder(section).map((lesson) => lesson.id),
    );
  }

  /**
   * Runs `change` on one Lesson of the open Course. The Course and its Progress are fixed when the
   * command runs; a Lesson the Course does not have is logged and changes nothing.
   */
  function changeLesson(
    lessonId: string,
    what: string,
    change: (recorder: ProgressRecorder, lessonIds: readonly string[]) => Promise<void>,
  ): Promise<void> {
    if (refusedWhileOpening()) {
      return Promise.resolve();
    }
    const known =
      openedCourse !== undefined &&
      lessonsInOrder(openedCourse).some((lesson) => lesson.id === lessonId);
    if (!known || progress === undefined) {
      logger.log({
        level: 'warn',
        message: `Cannot ${what} ${lessonId}: it is not a Lesson of the open Course.`,
      });
      return Promise.resolve();
    }
    return change(progress, [lessonId]);
  }

  return {
    openCourse(folder) {
      return openInTurn(folder, false);
    },
    async restoreCourse() {
      // A window opened for a Course hand-off opens that Course, not the one it remembers. Awaited
      // only when there is a note: with none, the remembered Course is queued in this same turn, so
      // a Course the learner opens meanwhile is queued after it and wins (a plain `await` would
      // let that open in first).
      const handOff = takeCourseHandOff(ports);
      const handedOff = handOff === undefined ? undefined : await handOff;
      if (handedOff !== undefined) {
        await openInTurn(handedOff, false);
        return;
      }
      const folder = storage.workspace.get(openCourseKey);
      if (typeof folder === 'string') {
        await openInTurn(folder, true);
      }
    },
    playLesson,
    pickCourse,
    unhideCourse: () => unhideCourse(ports),
    clearAudioCache: async () => {
      await audioCache.clear();
    },
    async goToLesson() {
      if (refusedWhileOpening()) {
        return;
      }
      if (openedCourse === undefined) {
        // With no Course there is no Lesson to go to: the key opens the Course picker (story 35).
        await pickCourse();
        return;
      }
      const course = openedCourse;
      const model = () =>
        buildLessonPicker(
          course,
          progress?.current() ?? { lessons: {} },
          lengthJob?.lengths() ?? new Map(),
        );
      // The live picker, so a length that lands while it is open shows in it (ADR 0109).
      const picker = ui.openPicker(model(), () => undefined);
      const follow = (): void => {
        if (course === openedCourse) {
          picker.update(model());
        }
      };
      followLengths = follow;
      const intent = await picker.answer;
      if (followLengths === follow) {
        followLengths = undefined;
      }
      if (intent !== undefined) {
        if (course === openedCourse) {
          playLesson(intent.lessonId, intent.type === 'playLessonFromStart');
        } else {
          logger.log({
            level: 'info',
            message: `Ignored ${intent.lessonId}: another Course was opened while the picker was open.`,
          });
        }
      }
    },
    markLessonDone(lessonId) {
      return changeLesson(lessonId, 'mark done', markLessonsDone);
    },
    markLessonNotDone(lessonId) {
      return changeLesson(lessonId, 'mark not done', resetLessons);
    },
    toggleLessonDone() {
      if (refusedWhileOpening()) {
        return Promise.resolve();
      }
      // The Lesson is the one the learner is on when they press the key (ADR 0064).
      const lesson = loaded.lesson();
      if (lesson === undefined || progress === undefined) {
        ui.showMessage({ severity: 'info', text: 'Open a Lesson first, then mark it done.' });
        return Promise.resolve();
      }
      return lessonStatus(progress.current(), lesson.id) === 'done'
        ? resetLessons(progress, [lesson.id])
        : markLessonsDone(progress, [lesson.id]);
    },
    markSectionDone(sectionId) {
      return changeSection(sectionId, 'mark all done', markLessonsDone);
    },
    resetSection(sectionId) {
      return changeSection(sectionId, 'reset', resetLessons);
    },
    async resetCourseProgress() {
      if (refusedWhileOpening()) {
        return;
      }
      // The Course and its Progress are fixed now, before the question is awaited (ADR 0024).
      const course = openedCourse;
      const recorder = progress;
      if (course === undefined || recorder === undefined) {
        ui.showMessage({ severity: 'info', text: 'Open a Course first, then reset its Progress.' });
        return;
      }
      const name = basename(course.folder);
      const answer = await ui.ask({
        text: `Reset all Progress in “${name}”? Every Lesson's done mark and position goes. Resources and prepared sound are kept.`,
        accept: 'Reset progress',
        decline: 'Cancel',
      });
      if (answer !== 'accept') {
        return;
      }
      if (openedCourse !== course) {
        // The question is not modal: the learner opened another Course meanwhile.
        logger.log({
          level: 'info',
          message: `Not resetting ${course.folder}: it is no longer open.`,
        });
        ui.showMessage({
          severity: 'info',
          text: `FollowAlong did not reset “${name}”: it is no longer open. Open it and try again.`,
        });
        return;
      }
      const lessonIds = lessonsInOrder(course).map((lesson) => lesson.id);
      recorder.resetAll(lessonIds);
      loaded.progressReset(lessonIds);
      await showAndSave(recorder);
    },
    ...resourceCommands,
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
    zoom(action) {
      loaded.zoom(action);
    },
    statusBarClick(command) {
      loaded.statusBarClick(command);
    },
    async moveVideo(to) {
      const from = loaded.spot();
      if (from === undefined) {
        ui.showMessage({ severity: 'info', text: noLessonText });
        return;
      }
      const target = to ?? (await ui.pick(buildSpotPicker(from)));
      if (target !== undefined) {
        await loaded.move(target);
      }
    },
    async toggleAutoPause() {
      const mode = await toggleAutoPause(config, storage);
      if (loaded.spot() === undefined) {
        // No status bar marker to show it: say what the key did.
        const text =
          mode === 'off'
            ? 'FollowAlong: auto-pause is off.'
            : `FollowAlong: auto-pause is on (${mode}).`;
        ui.showMessage({ severity: 'info', text });
      }
    },
    async toggleVideo() {
      if (loaded.spot() === undefined) {
        ui.showMessage({ severity: 'info', text: noLessonText });
        return;
      }
      await loaded.toggleVideo();
    },
    documentEdited(edit) {
      if (isTyping(edit, storage.folder)) {
        loaded.typed();
      }
    },
    async close() {
      // An open under way leaves its Lesson and saves it first; then this window's Lesson.
      await opening;
      await loaded.leave();
      loaded.dispose();
      limitWatch.dispose();
      modeWatch.dispose();
      stopBackgroundWork();
    },
    nextLesson() {
      moveToLesson(1);
    },
    previousLesson() {
      moveToLesson(-1);
    },
    dispose() {
      loaded.dispose();
      limitWatch.dispose();
      modeWatch.dispose();
      stopBackgroundWork();
    },
  };
}
