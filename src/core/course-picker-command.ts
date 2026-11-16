/**
 * _Open Course…_ (`Ctrl+'` `C`): the Course picker as a command. It reads the Courses roots and the
 * Recent Courses, shows the picker ({@link showCoursePicker}), and carries out what the learner
 * picked: open a Course or one of its videos, open it in a new window (the Course hand-off), add a
 * Courses root, remove a Recent Course, or Locate… a moved one. The last three show the picker
 * again. The Courses themselves are opened by the core's open queue, which this module is given.
 */
import { handOffCourse } from './course-hand-off.js';
import { createCourseScans } from './course-list-cache.js';
import { addCoursesRoot, readCoursesRoots, sameFolder } from './courses-roots.js';
import { showCoursePicker } from './live-course-picker.js';
import { locateCourse } from './locate-course.js';
import type { Ports } from './ports.js';
import { readRecent, removeRecent } from './recent-courses.js';

/** What the command needs of the Course open in this window, and of opening another. */
export interface CoursePickerHost {
  /** The folder of the Course open in this window, if any: it is tagged (open). */
  openFolder(): string | undefined;
  /** Saves the open Course's Progress, so what it has not saved yet moves with a Locate…. */
  saveProgress(): Promise<void>;
  /** Opens the Course in `folder` in this window; with `video`, plays that Lesson of it. */
  open(folder: string, video?: string): Promise<void>;
}

/**
 * The Course picker command for one window. It tells the learner once per window about a Courses
 * root setting entry that is not a full path, and about a Courses root it cannot read.
 */
export function createCoursePickerCommand(
  ports: Ports,
  host: CoursePickerHost,
): () => Promise<void> {
  const { storage, ui, logger, config } = ports;
  /** The Courses roots setting entries, and the roots, the learner was told about in this window. */
  const warnedRoots = new Set<string>();
  const warnedUnreadable = new Set<string>();
  const courseScans = createCourseScans(ports);

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

  async function pickCourse(): Promise<void> {
    const { roots, notAbsolute } = readCoursesRoots(config);
    warnNotAbsolute(notAbsolute);
    const intent = await showCoursePicker({
      ports,
      scans: courseScans,
      roots,
      recent: readRecent(storage.global),
      openFolder: () => host.openFolder(),
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
        await host.open(intent.folder);
        break;
      case 'openCourseInNewWindow':
        await handOffCourse(ports, intent.folder);
        break;
      case 'playVideo':
        await host.open(intent.folder, intent.video);
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
      case 'locateCourse': {
        const open = host.openFolder();
        if (open !== undefined && sameFolder(open, intent.folder)) {
          // The Course that moved is still open: what it has not saved yet is carried too.
          await host.saveProgress();
        }
        // Shown again either way: the entry is re-pointed, or still missing after a cancel.
        await locateCourse(ports, intent.folder);
        await pickCourse();
        break;
      }
      case undefined:
        break;
    }
  }

  return pickCourse;
}
