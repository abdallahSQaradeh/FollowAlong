/**
 * Shows the Course picker (spec #12, stories 12 and 13; ADR 0058): at once, from the Course list
 * cache and the Recent Courses, busy while the Courses roots are scanned in the background. The
 * scan fills the list in when it is done, and the title bar's Refresh starts a new one. The list
 * itself is built by {@link buildCoursePicker}; this module decides when it is shown again.
 */
import { buildCoursePicker, type CoursePickerIntent } from './course-picker.js';
import type { CourseScans } from './course-list-cache.js';
import { buildFolderBrowser, type FolderBrowserIntent } from './folder-browser.js';
import type { QuickPickModel } from './quick-pick.js';
import type { CourseScan, ScannedCourse } from './course-scanner.js';
import type { Ports } from './ports.js';
import { recentCourses, recentCoursesUnchecked } from './recent-courses.js';

export interface CoursePickerSession {
  readonly ports: Pick<Ports, 'fileSystem' | 'ui' | 'logger'>;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  let busy = true;
  let closed = false;
  /** Counts what is shown (redraws) and what is asked for (scans): only the latest counts. */
  let drawn = 0;
  let newestScan = 0;

  /** Set while the learner walks folders (Browse…, ADR 0066): the quick pick shows them, not the Courses. */
  let browsing = false;

  const view = (): QuickPickModel<PickerIntent> =>
    browsing
      ? buildFolderBrowser({ roots: roots.map((path) => ({ path })) })
      : buildCoursePicker({
          hasRoots: roots.length > 0,
          courses,
          recent: recentShown,
          openFolder: session.openFolder(),
          scanning: busy,
        });

  /** Looks at which Recent Courses are missing, then shows the list as it is now. */
  const redraw = async (): Promise<void> => {
    drawn += 1;
    const mine = drawn;
    let checked = recentShown;
    try {
      checked = await recentCourses(ports, recent, courses);
    } catch (error) {
      ports.logger.log({
        level: 'error',
        message: `Could not look at the Recent Courses: ${describe(error)}`,
      });
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
      ports.logger.log({ level: 'error', message: `The Course scan failed: ${describe(error)}` });
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
    busy = false;
    await redraw();
  };

  const picker = ports.ui.openPicker<PickerIntent>(view(), (intent) => {
    switch (intent.type) {
      case 'refreshCourses':
        busy = true;
        drawn += 1;
        picker.update(view());
        void showScan(scans.scan(roots, recent, { fresh: true }));
        break;
      case 'browse':
        browsing = true;
        picker.update(view());
        break;
      case 'backToCourses':
        browsing = false;
        picker.update(view());
        break;
      default:
        break;
    }
  });
  if (roots.length > 0) {
    void showScan(scans.scan(roots, recent));
  } else {
    busy = false;
    void redraw();
  }
  const intent = await picker.answer;
  closed = true;
  return intent;
}
