/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import {
  buildCourse,
  findSection,
  lessonsInOrder,
  type Course,
  type Lesson,
} from './course-model.js';
import { FileSystemError, type Ports } from './ports.js';
import { fallbackRoot } from './course-data.js';
import { createCourseScans } from './course-list-cache.js';
import { showCoursePicker } from './live-course-picker.js';
import { addCoursesRoot, playerFolders, readCoursesRoots, sameFolder } from './courses-roots.js';
import { locateCourse } from './locate-course.js';
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
import { openResources, type ResourceStore } from './resource-store.js';
import {
  attachChoice,
  checkWebUrl,
  resourceName,
  resourcePath,
  resourceTarget,
  urlLabel,
  type ResourceRecord,
} from './resources.js';
import { readFolderListing } from './folder-listing.js';
import { lessonStatus, openProgress, resumePosition, type ProgressRecorder } from './progress.js';
import { openSidecarSound, type SidecarSound } from './sidecar-sound.js';
import { readRecent, recordOpened, removeRecent } from './recent-courses.js';
import { createTerminalKeysOffer } from './terminal-keys.js';

/** Workspace storage key: the folder of the Course open in this workspace (story 21). */
const openCourseKey = 'openCourse';

/** What a Resource is attached to: the whole Course, or one of its Lessons. */
type AttachTarget =
  { readonly kind: 'course' } | { readonly kind: 'lesson'; readonly lessonId: string };

export interface FollowAlong {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** Opens the Course that was open in this workspace, if any, paused where the learner left it. */
  restoreCourse(): Promise<void>;
  /** Plays a Lesson of the open Course, by its id, beside the code. */
  playLesson(lessonId: string): void;
  /**
   * Attaches a file, from anywhere on disk, as a Resource of a Lesson of the open Course: the
   * tree's "+". Without `absolutePath` it first asks for the file; the Lesson and its Course are
   * fixed when the command runs, so a Course opened while the dialog is up never receives it.
   */
  attachResource(lessonId: string, absolutePath?: string): Promise<void>;
  /**
   * Attaches a file, from anywhere on disk, as a Resource of the whole open Course: the "+" on the
   * Course node. Without `absolutePath` it first asks for the file; the Course is fixed when the
   * command runs, so a Course opened while the dialog is up never receives it.
   */
  attachCourseResource(absolutePath?: string): Promise<void>;
  /**
   * The attach command from the chord or the Command Palette: asks for a file and attaches it to
   * the Loaded Lesson when the command runs. The Lesson keeps playing meanwhile.
   */
  attachToLoadedLesson(): Promise<void>;
  /** Opens a Resource of the open Course, by its tree id, in a tab beside the code. */
  openResource(resourceId: string): Promise<void>;
  /**
   * Detaches a Resource of the open Course, by its tree id: the reference goes, the file on disk
   * stays. The Course is fixed when the command runs.
   */
  detachResource(resourceId: string): Promise<void>;
  /**
   * Points a Resource of the open Course, by its tree id, at another file. Without `absolutePath`
   * it first asks for the file; the Course is fixed when the command runs, so a Course opened
   * while the dialog is up never has the Resource relinked.
   */
  relinkResource(resourceId: string, absolutePath?: string): Promise<void>;
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
  /** The `followalong.ffmpegPath` values the learner was told are ignored in this window. */
  const warnedFfmpegPaths = new Set<string>();

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
   * Draws the Resources of `store` in the tree, if its Course is the one open now. A change is
   * made in the data of the Course it was asked in, even if the learner has opened another Course
   * since; the tree then keeps showing that other Course.
   */
  function showResources(course: Course, store: ResourceStore): boolean {
    if (openedCourse?.folder !== course.folder) {
      return false;
    }
    drawTreeWith(store);
    return true;
  }

  /**
   * After a Resources change was tried: the tree shows what is there now (also when the change no
   * longer applied, because another window got there first). A change made in a Course that is no
   * longer open is said, because the tree shows another Course and the learner might do it again.
   */
  function showResourceChange(
    course: Course,
    store: ResourceStore,
    change: { readonly made: boolean; readonly said: string },
  ): void {
    if (!showResources(course, store) && change.made) {
      ui.showMessage({
        severity: 'info',
        text: `FollowAlong ${change.said} in “${basename(course.folder)}”, which is no longer open.`,
      });
    }
  }

  /**
   * The open Course, its Resources and one of them, as a Resource command finds them when it runs.
   * That fixes the Course before any dialog is awaited (ADR 0024).
   */
  function resourceOfOpenCourse(
    resourceId: string,
    action: string,
  ): { course: Course; store: ResourceStore; record: ResourceRecord } | undefined {
    const course = openedCourse;
    const store = resourceStore;
    const record = store?.find(resourceId);
    if (course === undefined || store === undefined || record === undefined) {
      logger.log({
        level: 'warn',
        message: `Cannot ${action} ${resourceId}: it is not a Resource of the open Course.`,
      });
      return undefined;
    }
    return { course, store, record };
  }

  /**
   * Every attach route (a Lesson from its "+" or the chord, the whole Course from its "+"), once
   * it has fixed what the Resource goes to and that Course: asks whether it is a file or a URL and
   * for which one, when none is given yet, then attaches it. A closed choice, dialog or box attaches
   * nothing. A file given up front (by a drop or a test) skips the choice.
   */
  async function attachTo(
    course: Course,
    store: ResourceStore,
    target: AttachTarget,
    absolutePath?: string,
  ): Promise<void> {
    const where =
      target.kind === 'course'
        ? 'the Course'
        : `“${lessonsInOrder(course).find((lesson) => lesson.id === target.lessonId)?.title ?? target.lessonId}”`;
    if (absolutePath === undefined) {
      const choice = await ui.pick(attachChoice(target.kind));
      if (choice === undefined) {
        return;
      }
      if (choice === 'url') {
        await attachUrlTo(course, store, target, where);
        return;
      }
    }
    const path =
      absolutePath ??
      (await ui.pickFile({
        title:
          target.kind === 'course'
            ? 'Attach a file to this Course'
            : 'Attach a file to this Lesson',
        openLabel: 'Attach',
      }));
    if (path === undefined) {
      return;
    }
    const made =
      target.kind === 'course'
        ? await store.attachToCourse(path)
        : await store.attach(target.lessonId, path);
    showResourceChange(course, store, { made, said: `attached “${basename(path)}” to ${where}` });
  }

  /** The “URL…” half of {@link attachTo}: asks for the address, checks it, and attaches it. */
  async function attachUrlTo(
    course: Course,
    store: ResourceStore,
    target: AttachTarget,
    where: string,
  ): Promise<void> {
    const typed = await ui.askText({
      title:
        target.kind === 'course' ? 'Attach a URL to this Course' : 'Attach a URL to this Lesson',
      prompt: 'The address of a web page, to open in Simple Browser beside the code.',
      placeholder: 'https://…',
      validate: (text) => {
        const checked = checkWebUrl(text);
        return checked.ok ? undefined : checked.problem;
      },
    });
    if (typed === undefined) {
      return;
    }
    // The box checks as the learner types; the core does not rely on it (ADR 0047).
    const checked = checkWebUrl(typed);
    if (!checked.ok) {
      logger.log({ level: 'warn', message: `Not attaching a URL: ${checked.problem}` });
      ui.showMessage({
        severity: 'warning',
        text: `FollowAlong did not attach it. ${checked.problem}`,
      });
      return;
    }
    const made =
      target.kind === 'course'
        ? await store.attachUrlToCourse(checked.url)
        : await store.attachUrl(target.lessonId, checked.url);
    showResourceChange(course, store, {
      made,
      said: `attached “${urlLabel(checked.url)}” to ${where}`,
    });
  }

  /**
   * Opens a URL Resource in Simple Browser. The address is checked again here, not only when it was
   * attached: `resources.json` is a file on disk that anything could have written (ADR 0047).
   */
  async function openUrl(stored: string): Promise<void> {
    const checked = checkWebUrl(stored);
    if (!checked.ok) {
      logger.log({
        level: 'warn',
        message: `Not opening a URL Resource: ${checked.problem} (${stored.slice(0, 80)})`,
      });
      ui.showMessage({
        severity: 'warning',
        text: `FollowAlong did not open this Resource. ${checked.problem} Detach it in the Lesson tree.`,
      });
      return;
    }
    try {
      await ui.openResource({ kind: 'url', url: checked.url });
    } catch (error) {
      logger.log({
        level: 'warn',
        message: `Could not open ${checked.url}: ${error instanceof Error ? error.message : String(error)}`,
      });
      ui.showMessage({
        severity: 'error',
        text: `FollowAlong could not open “${urlLabel(checked.url)}” in Simple Browser.`,
      });
    }
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
      ports.player.show({
        title: playing.title,
        resourceRoots: resourceRootsOf(openedCourse),
      });
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
      const store = await openResources(folder, ports);
      const inOrder = lessonsInOrder(course);
      const first = inOrder[0];
      const recorder = first === undefined ? undefined : await openProgress(folder, ports);
      if (first === undefined || recorder === undefined) {
        openedCourse = course;
        resourceStore = store;
        progress = recorder;
        sidecarSound = openSidecarSound(folder, ports, warnedFfmpegPaths);
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
      sidecarSound = openSidecarSound(folder, ports, warnedFfmpegPaths);
      drawTree(buildLessonTree(course, store.current(), recorder.current(), store.missing()));
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
        message: `Could not remember ${folder} as a Recent Course: ${error instanceof Error ? error.message : String(error)}`,
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

  /** Plays a Lesson of the open Course, by its id, from 5 s before where the learner left it. */
  function playLesson(lessonId: string): void {
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
    play(course, lesson, saved === undefined ? 0 : resumePosition(saved, lesson.id), true);
  }

  /** The Courses roots setting entries, and the roots, the learner was told about in this window. */
  const warnedRoots = new Set<string>();
  const warnedUnreadable = new Set<string>();
  const courseScans = createCourseScans(ports);
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

  /** The Course picker. */
  async function pickCourse(): Promise<void> {
    const { roots, notAbsolute } = readCoursesRoots(config);
    warnNotAbsolute(notAbsolute);
    const intent = await showCoursePicker({
      ports,
      scans: courseScans,
      roots,
      recent: readRecent(storage.global),
      openFolder: () => openedCourse?.folder,
      warnUnreadableRoot(root) {
        // Once per window: a drive that stays unplugged would otherwise be named at every open.
        if (!warnedUnreadable.has(root)) {
          warnedUnreadable.add(root);
          ui.showMessage({
            severity: 'warning',
            text: `FollowAlong can't read the Courses root “${root}”. Is the folder or drive still there?`,
          });
        }
      },
    });
    switch (intent?.type) {
      case 'openCourse':
        await openInTurn(intent.folder, false);
        break;
      case 'playVideo':
        await openInTurn(intent.folder, false, intent.video);
        break;
      case 'addCoursesRoot':
        // The learner added a root to pick a Course from it: show the list again, with its Courses.
        if (await chooseCoursesRoot()) {
          await pickCourse();
        }
        break;
      case 'removeRecentCourse':
        await removeRecent(storage.global, intent.folder);
        await pickCourse();
        break;
      case 'locateCourse':
        if (openedCourse !== undefined && sameFolder(openedCourse.folder, intent.folder)) {
          // The Course that moved is still open: what it has not saved yet is carried too.
          await progress?.save();
        }
        // Shown again either way: the entry is re-pointed, or still missing after a cancel.
        await locateCourse(ports, intent.folder);
        await pickCourse();
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
      if (refusedWhileOpening()) {
        return;
      }
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
      recorder.resetAll();
      loaded.progressReset(lessonsInOrder(course).map((lesson) => lesson.id));
      await showAndSave(recorder);
    },
    async attachResource(lessonId, absolutePath) {
      const course = openedCourse;
      const store = resourceStore;
      if (course === undefined || store === undefined) {
        logger.log({ level: 'warn', message: `Cannot attach to ${lessonId}: no Course is open.` });
        return;
      }
      if (!lessonsInOrder(course).some((lesson) => lesson.id === lessonId)) {
        logger.log({
          level: 'warn',
          message: `Cannot attach to ${lessonId}: it is not a Lesson of the open Course.`,
        });
        return;
      }
      await attachTo(course, store, { kind: 'lesson', lessonId }, absolutePath);
    },
    async attachCourseResource(absolutePath) {
      // The Course and its store are fixed now, before the dialog opens (ADR 0024).
      const course = openedCourse;
      const store = resourceStore;
      if (course === undefined || store === undefined) {
        logger.log({ level: 'warn', message: 'Cannot attach to the Course: no Course is open.' });
        return;
      }
      if (lessonsInOrder(course).length === 0) {
        // Such a Course shows only its message, not a tree with a Course node to attach to.
        logger.log({ level: 'warn', message: 'Cannot attach to the Course: it has no Lessons.' });
        return;
      }
      await attachTo(course, store, { kind: 'course' }, absolutePath);
    },
    async attachToLoadedLesson() {
      // The Lesson is fixed when the learner presses the key, not when the dialog closes: the
      // learner means the Lesson they were watching, even if the next one starts meanwhile. Its
      // Course is fixed too, because another Course can hold a Lesson with the same id.
      // The Loaded Lesson is always one of the open Course's: `open` leaves it before switching.
      const lesson = loaded.lesson();
      const course = openedCourse;
      const store = resourceStore;
      if (lesson === undefined || course === undefined || store === undefined) {
        ui.showMessage({
          severity: 'info',
          text: 'Open a Lesson first, then attach a Resource to it.',
        });
        return;
      }
      try {
        await attachTo(course, store, { kind: 'lesson', lessonId: lesson.id });
      } finally {
        // The dialog took keyboard focus: hand it back, also when the attach failed (ADR 0023).
        ui.returnFocus();
      }
    },
    async detachResource(resourceId) {
      const found = resourceOfOpenCourse(resourceId, 'detach');
      if (found === undefined) {
        return;
      }
      const { course, store, record } = found;
      const made = await store.detach(resourceId);
      showResourceChange(course, store, {
        made,
        said: `detached “${resourceName(course.folder, record)}”`,
      });
    },
    async relinkResource(resourceId, absolutePath) {
      const found = resourceOfOpenCourse(resourceId, 'relink');
      if (found === undefined) {
        return;
      }
      const { course, store, record } = found;
      if (record.kind === 'url') {
        // Relink points a Resource at another file; a URL has none (ADR 0047).
        logger.log({ level: 'info', message: `Not relinking ${resourceId}: it is a URL.` });
        ui.showMessage({
          severity: 'info',
          text: 'A URL can’t be relinked. Detach it and attach the new address instead.',
        });
        return;
      }
      const previousName = basename(resourcePath(course.folder, record));
      const path =
        absolutePath ??
        (await ui.pickFile({
          title: `Relink “${previousName}” to another file`,
          openLabel: 'Relink',
        }));
      if (path === undefined) {
        return;
      }
      const made = await store.relink(resourceId, path);
      showResourceChange(course, store, {
        made,
        said: `relinked “${previousName}” to “${basename(path)}”`,
      });
      if (!made && store.find(resourceId) === undefined) {
        // Another window detached it while the dialog was open: nothing is left to point anywhere.
        ui.showMessage({
          severity: 'info',
          text: `FollowAlong could not relink “${previousName}”: it is no longer one of the Resources of “${basename(course.folder)}”.`,
        });
      }
    },
    async openResource(resourceId) {
      const found = resourceOfOpenCourse(resourceId, 'open');
      if (found === undefined) {
        return;
      }
      const { course, store, record } = found;
      if (record.kind === 'url') {
        await openUrl(record.url);
        return;
      }
      const path = resourcePath(course.folder, record);
      // Looked at now, not when the Course opened: the file may have gone, or come back, since.
      if (await store.checkFiles()) {
        showResources(course, store);
      }
      if (store.missing().has(record.id)) {
        ui.showMessage({
          severity: 'warning',
          text: `FollowAlong can’t find “${basename(path)}”: it was moved, renamed or deleted. Use Relink… on it in the Lesson tree to point it at the file’s new place.`,
        });
        return;
      }
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
