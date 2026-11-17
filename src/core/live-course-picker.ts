/**
 * Shows the Course picker (spec #12, stories 12 and 13; ADR 0058): at once, from the Course list
 * cache and the Recent Courses, busy while the Courses roots are scanned in the background. The
 * scan fills the list in when it is done, and the title bar's Refresh starts a new one. The list
 * itself is built by {@link buildCoursePicker}; this module decides when it is shown again.
 */
import { messageOf } from './logger.js';
import { buildCoursePicker, type CoursePickerIntent } from './course-picker.js';
import { readProgressLines } from './course-progress-lines.js';
import { folderKey, keyOf, sameFolder } from './folder-identity.js';
import { hideCourse, readHidden, type HiddenCourse } from './hidden-courses.js';
import type { CourseScans } from './course-list-cache.js';
import {
  buildFolderBrowser,
  type BrowsedFolder,
  type FolderBrowserIntent,
  type FolderBrowserView,
} from './folder-browser.js';
import { folderLabel } from './course-scanner.js';
import { FileSystemError } from './ports.js';
import { lookForVideos, readBrowsedFolder } from './read-browsed-folder.js';
import type { QuickPickModel } from './quick-pick.js';
import type { CourseScan, ScannedCourse } from './course-scanner.js';
import type { Ports } from './ports.js';
import { recentCourses, recentCoursesUnchecked } from './recent-courses.js';

export interface CoursePickerSession {
  readonly ports: Pick<Ports, 'fileSystem' | 'storage' | 'ui' | 'logger'>;
  readonly scans: CourseScans;
  /** The Courses roots, as the setting has them. */
  readonly roots: readonly string[];
  /** The Recent Courses' folders, newest first. */
  readonly recent: readonly string[];
  /** The folder of the Course open in this window, if any: it is tagged (open). */
  openFolder(): string | undefined;
  /** Tells the learner about a Courses root that could not be read, once per window. */
  warnUnreadableRoot(root: string): void;
}

/** What the learner can ask of the picker: for its list of Courses, or for the Folder browser. */
export type PickerIntent = CoursePickerIntent | FolderBrowserIntent;

/**
 * Shows the picker and resolves with the intent the learner picked, or `undefined` when they
 * closed it. A scan still running then goes on, and is cached when it ends.
 */
export async function showCoursePicker(
  session: CoursePickerSession,
): Promise<PickerIntent | undefined> {
  const { ports, scans, roots, recent } = session;
  // The cached Courses, or nothing yet. Busy until the scan is done and the Recent Courses are
  // looked at: the picker never waits for the disk before it shows.
  let courses: readonly ScannedCourse[] = scans.cached(roots) ?? [];
  let recentShown = recentCoursesUnchecked(recent, courses);
  let scanning = true;
  /** Progress lines being read in the background, each batch counted until it is done. */
  let reading = 0;
  /** Looks at the Recent Courses under way: the list is complete only when they are looked at. */
  let checking = 0;
  /** The Progress lines read so far, and the Courses already asked for (read once per scan). */
  const lines = new Map<string, string | undefined>();
  const asked = new Set<string>();
  /** The folders the learner hid, by {@link folderKey}: read when the picker opens. */
  const hidden = new Set(
    readHidden(ports.storage.global).map((course) => folderKey(course.folder)),
  );
  let closed = false;
  /** Counts what is shown (redraws) and what is asked for (scans): only the latest counts. */
  let drawn = 0;
  let newestScan = 0;

  /** Set while the learner walks folders (Browse…, ADR 0066): the quick pick shows them, not the Courses. */
  let browsing: FolderBrowserView | undefined;
  /** Counts the folders the learner asked for: of two, only the later one is shown. */
  let newestFolder = 0;

  /** Whether the Folder browser is still looking at what it lists: it is busy, whatever else lands. */
  let browsingBusy = false;

  const view = (): QuickPickModel<PickerIntent> =>
    browsing !== undefined
      ? { ...buildFolderBrowser(browsing), ...(browsingBusy ? { busy: true } : {}) }
      : buildCoursePicker({
          hasRoots: roots.length > 0,
          courses,
          recent: recentShown,
          openFolder: session.openFolder(),
          scanning: scanning || reading > 0 || checking > 0,
          progressLines: lines,
          hidden,
        });

  /** Looks at which Recent Courses are missing, then shows the list as it is now. */
  const redraw = async (): Promise<void> => {
    drawn += 1;
    const mine = drawn;
    let checked = recentShown;
    checking += 1;
    try {
      checked = await recentCourses(ports, recent, courses);
    } catch (error) {
      ports.logger.log({
        level: 'error',
        message: `Could not look at the Recent Courses: ${messageOf(error)}`,
      });
    } finally {
      checking -= 1;
    }
    if (!closed && mine === drawn) {
      recentShown = checked;
      picker.update(view());
    }
  };

  /** Waits for a scan and shows it, unless the picker is closed or a newer scan was asked for. */
  const showScan = async (scan: Promise<CourseScan>): Promise<void> => {
    newestScan += 1;
    const mine = newestScan;
    let found: CourseScan | undefined;
    try {
      found = await scan;
    } catch (error) {
      ports.logger.log({ level: 'error', message: `The Course scan failed: ${messageOf(error)}` });
    }
    if (closed || mine !== newestScan) {
      return;
    }
    if (found !== undefined) {
      courses = found.courses;
      for (const root of found.unreadableRoots) {
        session.warnUnreadableRoot(root);
      }
    }
    scanning = false;
    // Started before the redraw, so the list stays busy until the Progress lines are in.
    const reads = readLines();
    await redraw();
    await reads;
  };

  /**
   * Reads the Progress lines of the Courses shown that were not read yet, in the background, and
   * shows each batch when it is in. The picker is not waiting for them: it is open already.
   */
  const readLines = async (): Promise<void> => {
    const folders = [...recentShown.filter((course) => !course.missing), ...courses]
      .map((course) => course.folder)
      .filter((folder) => !asked.has(keyOf(folder)));
    for (const folder of folders) {
      asked.add(keyOf(folder));
    }
    if (folders.length === 0) {
      return;
    }
    reading += 1;
    try {
      const found = await readProgressLines(ports, folders, roots, () => closed);
      for (const [key, line] of found) {
        lines.set(key, line);
      }
    } finally {
      reading -= 1;
    }
    if (!closed) {
      picker.update(view());
    }
  };

  /** Shows the Folder browser at `next`, busy while it goes on looking at what it lists. */
  const showBrowser = (next: FolderBrowserView, looking: boolean): void => {
    browsing = next;
    browsingBusy = looking;
    picker.update(view());
  };

  /**
   * Shows the top of the Folder browser at once: the Courses roots, or the drives or home folder
   * when there is none. Which of them hold videos, and (under roots) the drives or home folder
   * to reach what is outside them, follow when they have been looked at.
   */
  const browseTop = async (stale: () => boolean): Promise<void> => {
    showBrowser(
      { kind: 'top', start: roots.map((path): BrowsedFolder => ({ path })), elsewhere: [] },
      true,
    );
    const found = await ports.fileSystem.startingFolders();
    if (stale()) {
      return;
    }
    const outside = found.filter((path) => !roots.some((root) => sameFolder(root, path)));
    const start = roots.length === 0 ? outside : roots;
    const places = [...start, ...(roots.length === 0 ? [] : outside)].map(
      (path): BrowsedFolder => ({ path }),
    );
    const top = (folders: readonly BrowsedFolder[]): FolderBrowserView => ({
      kind: 'top',
      start: folders.slice(0, start.length),
      elsewhere: folders.slice(start.length),
    });
    showBrowser(top(places), true);
    const looked = await lookForVideos(ports, places);
    if (!stale()) {
      showBrowser(top(looked), false);
    }
  };

  /** Shows what is in `folder`; the list the learner picked it from stays until it is read. */
  const browseFolder = async (folder: string, stale: () => boolean): Promise<void> => {
    browsingBusy = true;
    picker.update(view());
    const content = await readBrowsedFolder(ports, folder);
    if (stale()) {
      return;
    }
    // The folders are shown at once; which of them hold videos is looked at while they are.
    showBrowser({ kind: 'folder', folder, ...content }, true);
    const folders = await lookForVideos(ports, content.folders);
    if (!stale()) {
      showBrowser({ kind: 'folder', folder, folders, videos: content.videos }, false);
    }
  };

  /** Shows what is in `folder`, or the top of the Folder browser; the picker stays open. */
  const browseTo = async (folder: string | undefined): Promise<void> => {
    newestFolder += 1;
    const mine = newestFolder;
    /** Whether the picker is closed, or the learner asked for another folder since. */
    const stale = (): boolean => closed || mine !== newestFolder;
    const previous = browsing;
    try {
      await (folder === undefined ? browseTop(stale) : browseFolder(folder, stale));
    } catch (error) {
      if (error instanceof FileSystemError && folder !== undefined) {
        ports.logger.log({
          level: 'warn',
          message: `Cannot browse ${folder} (${error.message}).`,
        });
        ports.ui.showMessage({
          severity: 'warning',
          text: `FollowAlong can't read the folder “${folderLabel(folder)}”.`,
        });
      } else {
        ports.logger.log({
          level: 'error',
          message: `Could not browse ${folder ?? 'the start'}: ${messageOf(error)}`,
        });
      }
      if (!stale()) {
        // Back to the list the learner picked from (or, at the top, what is known of it), not busy.
        if (folder !== undefined) {
          browsing = previous;
        }
        browsingBusy = false;
        picker.update(view());
      }
    }
  };

  /** Hides a Course and shows the list again without it; the picker stays open. */
  const hide = async (course: HiddenCourse): Promise<void> => {
    // Gone from the list at once; the storage write follows, and a refusal is logged, not shown.
    hidden.add(folderKey(course.folder));
    picker.update(view());
    try {
      await hideCourse(ports.storage.global, course);
    } catch (error) {
      ports.logger.log({
        level: 'warn',
        message: `Could not keep “${course.folder}” in the hidden Courses: ${messageOf(error)}`,
      });
    }
  };

  const picker = ports.ui.openPicker<PickerIntent>(view(), (intent) => {
    switch (intent.type) {
      case 'refreshCourses':
        scanning = true;
        asked.clear();
        drawn += 1;
        picker.update(view());
        void showScan(scans.scan(roots, recent, { fresh: true }));
        break;
      case 'browse':
        void browseTo(undefined);
        break;
      case 'backToCourses':
        newestFolder += 1;
        browsing = undefined;
        browsingBusy = false;
        picker.update(view());
        break;
      case 'browseTo':
        void browseTo(intent.folder);
        break;
      case 'hideCourse':
        void hide({ folder: intent.folder, name: intent.name });
        break;
      default:
        break;
    }
  });
  if (roots.length > 0) {
    void readLines();
    void showScan(scans.scan(roots, recent));
  } else {
    scanning = false;
    void redraw();
  }
  const intent = await picker.answer;
  closed = true;
  return intent;
}
