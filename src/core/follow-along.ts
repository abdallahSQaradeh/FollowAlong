/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename } from 'node:path';

import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import { buildCourse, lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { FileSystemError, type Disposable, type Ports } from './ports.js';
import { openCourseData, type CourseData } from './course-data.js';
import { buildCoursePicker } from './course-picker.js';
import { scanCourses } from './course-scanner.js';
import { addCoursesRoot, playerFolders, readCoursesRoots } from './courses-roots.js';
import { buildLessonPicker } from './lesson-picker.js';
import { buildLessonTree } from './lesson-tree.js';
import {
  buildStatusBar,
  hiddenStatusBar,
  type StatusBarCommand,
  type StatusBarModel,
} from './status-bar.js';
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
import { createTerminalKeysOffer } from './terminal-keys.js';

export interface FollowAlong {
  /** Opens a Course folder, shows its Lessons in the tree and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
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

/** The rung a click on the status bar speed item goes to: one up, and round to the slowest. */
function cycledRate(rate: number): number {
  return rate >= fastest ? slowest : nextRate(rate, 'up');
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

  /** The playhead and length the player last reported for the current Lesson, in seconds. */
  let position = 0;
  let duration = 0;
  /** What the status bar shows now; a new model is sent to the UI only when it differs. */
  let statusBar: StatusBarModel = hiddenStatusBar;

  function refreshStatusBar(): void {
    const next =
      current === undefined
        ? hiddenStatusBar
        : buildStatusBar({
            playing: playback.playing,
            position,
            duration,
            rate,
            shortStep: stepSeconds('short'),
          });
    if (JSON.stringify(next) === JSON.stringify(statusBar)) {
      return;
    }
    statusBar = next;
    ui.showStatusBar(next);
  }

  /** Starts what the player reported about a Lesson again: nothing yet. */
  function resetPlayhead(autoplay: boolean): void {
    playback = freshPlayback(autoplay);
    position = 0;
    duration = 0;
  }

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
    resetPlayhead(command.autoplay);
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
          if (event.type === 'ended') {
            offerNextLesson();
          }
        }
        break;
      case 'nextClicked':
        // A click for a Lesson the learner has left, or one no Course holds any more, is stale.
        if (event.lessonId === current?.id) {
          const next = lessonBeside(1);
          if (next?.target !== undefined) {
            play(next.course, next.target);
          }
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
      case 'userInteracted':
        ui.returnFocus();
        break;
      case 'timeUpdate':
        if (event.lessonId === current?.id) {
          position = event.position;
          duration = event.duration;
        }
        break;
    }
    refreshStatusBar();
  }

  /**
   * The Lesson `offset` places from the current one in Course order. `undefined` when the current
   * Lesson is not in the open Course (a Course with no Lessons was opened after it): there is no
   * place to count from. `target` is `undefined` beyond either end of the Course.
   */
  function lessonBeside(
    offset: number,
  ): { readonly course: Course; readonly target: Lesson | undefined } | undefined {
    const course = openedCourse;
    const lessons = course === undefined ? [] : lessonsInOrder(course);
    const here = lessons.findIndex((lesson) => lesson.id === current?.id);
    return course === undefined || here === -1
      ? undefined
      : { course, target: lessons[here + offset] };
  }

  /**
   * The Lesson has ended: the player stops on its last frame and, when a Lesson follows in Course
   * order, shows "Next: <title>". The core never loads it by itself (spec #12, story 50); that is
   * the learner's click on the overlay, or `nextLesson`.
   */
  function offerNextLesson(): void {
    const next = lessonBeside(1)?.target;
    if (next !== undefined) {
      player.send({ type: 'showNext', title: next.title });
    }
  }

  /** Forgets the loaded Lesson: nothing is loaded now, so the commands find no Lesson. */
  function unloadLesson(): void {
    current = undefined;
    resetPlayhead(false);
    refreshStatusBar();
  }

  /** The learner closed the player: a new page starts from scratch, at normal speed. */
  function onPlayerClosed(): void {
    playerReady = false;
    rate = normalRate;
    askedRates = [];
    unloadLesson();
  }

  const subscriptions: Disposable[] = [
    player.onEvent(onPlayerEvent),
    player.onDidClose(onPlayerClosed),
    // The back item names the short step, so a changed setting shows at once.
    config.onDidChange((affects) => {
      if (affects(stepSettings.short)) {
        refreshStatusBar();
      }
      if (playerReady && affects('resumeRewind')) {
        sendResumeRewind();
      }
    }),
  ];

  /** The open Course: what the Lesson tree shows, and where `playLesson` looks up a Lesson. */
  let openedCourse: Course | undefined;
  /** The open Course's Course data, and the Resources read from it. */
  let courseData: CourseData | undefined;
  let resources: ResourcesData = noResources;
  /** How many Course opens have started: the number of the latest, which is the one that wins. */
  let opens = 0;
  /** Attaches run one at a time, so two quick attaches cannot overwrite each other. */
  let attaching: Promise<unknown> = Promise.resolve();

  /** Offers, once, to add the one-press commands to the terminal's skip-shell setting. */
  const offerTerminalKeys = createTerminalKeysOffer(ports);

  /** Shows `lesson` in the player beside the code, and loads it as soon as the player can. */
  function play(course: Course, lesson: Lesson): void {
    current = lesson;
    // Nothing is known about this Lesson until the player loads it and reports.
    resetPlayhead(false);
    logger.log({ level: 'info', message: `Playing ${lesson.id} of ${course.folder}` });
    ui.selectLesson(lesson.id);
    const shown = player.show({
      title: lesson.title,
      resourceRoots: playerFolders(readCoursesRoots(config), course.folder, storage.folder),
    });
    if (shown === 'created') {
      // A new page is not ready and plays at normal speed.
      playerReady = false;
      rate = normalRate;
      askedRates = [];
    } else if (playerReady) {
      loadCurrent();
    }
    refreshStatusBar();
    offerTerminalKeys();
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

  /**
   * The play/pause command: pauses a playing Lesson, else resumes it, first stepping back by the
   * `followalong.resumeRewind` setting (a manual resume, ADR 0016).
   */
  function playPause(): void {
    if (!hasPlayableLesson('Play/pause')) {
      return;
    }
    if (playback.playing) {
      player.send({ type: 'pause' });
      return;
    }
    resume(resumeRewindSeconds());
  }

  /** The step commands. */
  function seekStep(size: StepSize, direction: StepDirection): void {
    if (!hasPlayableLesson('Seek step')) {
      return;
    }
    const seconds = stepSeconds(size);
    player.send({ type: 'seekBy', seconds: direction === 'back' ? -seconds : seconds });
  }

  /** Asks the player for `next`, the rung a speed command chose. */
  function setRate(next: number): void {
    // Counted at once, so presses in a row climb before the player has answered the first.
    if (next !== rate) {
      // The player reports only a change, so a press that changes nothing has no answer to wait for.
      askedRates.push(next);
    }
    rate = next;
    player.send({ type: 'setRate', rate });
    refreshStatusBar();
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
    const beside = lessonBeside(offset);
    if (beside === undefined) {
      ui.showMessage({
        severity: 'info',
        text: 'FollowAlong: no Lesson is open. Open a Course first.',
      });
      return;
    }
    if (beside.target !== undefined) {
      play(beside.course, beside.target);
    }
  }

  /**
   * Opens a Course folder in place of the open Course. Opens can overlap (two quick picks): the
   * latest one wins, and an earlier one that finishes reading after it changes nothing.
   */
  async function openCourse(folder: string): Promise<void> {
    opens += 1;
    const thisOpen = opens;
    const superseded = (): boolean => {
      if (thisOpen === opens) {
        return false;
      }
      logger.log({
        level: 'info',
        message: `Not opening ${folder}: another Course was opened since.`,
      });
      return true;
    };
    let course: Course;
    try {
      course = buildCourse(await readFolderListing(ports, folder, basename(folder)));
    } catch (error) {
      // A later open replaced this one: what this folder failed with no longer matters.
      if (error instanceof FileSystemError && superseded()) {
        return;
      }
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
    if (superseded()) {
      return;
    }
    openedCourse = course;
    courseData = data;
    resources = stored;
    const first = lessonsInOrder(course)[0];
    if (first === undefined) {
      const text = `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(folder)}”. If the Course is zipped, extract it first.`;
      ui.showLessonTree({ message: text, nodes: [] });
      ui.showMessage({ severity: 'warning', text });
      // The player still shows the Lesson it had, but this Course has none to offer: the
      // commands and the status bar items follow the Course the learner opened.
      // The video would play on with every control gone, so it is stopped first.
      if (current !== undefined && playerReady) {
        player.send({ type: 'pause' });
      }
      unloadLesson();
      return;
    }
    ui.showLessonTree(buildLessonTree(course, resources));
    logger.log({ level: 'info', message: `Opened Course ${folder}` });
    play(course, first);
  }

  /** The Course picker. */
  async function pickCourse(): Promise<void> {
    const roots = readCoursesRoots(config);
    const scan = await scanCourses(ports, roots);
    for (const root of scan.unreadableRoots) {
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
        await openCourse(intent.folder);
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

  const followAlong: FollowAlong = {
    openCourse,
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
    async attachToLoadedLesson() {
      // The Lesson is fixed when the learner presses the key, not when the dialog closes: the
      // learner means the Lesson they were watching, even if the next one starts meanwhile.
      const lesson = current;
      if (lesson === undefined) {
        ui.showMessage({
          severity: 'info',
          text: 'Open a Lesson first, then attach a Resource to it.',
        });
        return;
      }
      try {
        const path = await ui.pickFile();
        if (path !== undefined) {
          await followAlong.attachResource(lesson.id, path);
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
    playPause,
    resumeWithoutRewind() {
      // Silent: an automatic resume must not tell the learner anything they did not ask for.
      if (current === undefined || !playerReady || playback.playing) {
        return;
      }
      resume(0);
    },
    seekStep,
    speedStep(direction) {
      if (hasPlayableLesson('Speed step')) {
        setRate(nextRate(rate, direction));
      }
    },
    statusBarClick(command) {
      switch (command) {
        case 'playPause':
          playPause();
          break;
        case 'seekBackShort':
          seekStep('short', 'back');
          break;
        case 'speedCycle':
          if (hasPlayableLesson('Speed cycle')) {
            setRate(cycledRate(rate));
          }
          break;
      }
      // The click gives the status bar item keyboard focus (VS Code makes the label focusable):
      // hand it back to the editor or terminal the learner used last (Focus return, ADR 0009).
      ui.returnFocus();
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
  return followAlong;
}
