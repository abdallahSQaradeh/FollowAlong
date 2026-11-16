/**
 * Shows the Course picker (spec #12, stories 12 and 13; ADR 0058): at once, from the Course list
 * cache and the Recent Courses, busy while the Courses roots are scanned in the background. The
 * scan fills the list in when it is done, and the title bar's Refresh starts a new one. The list
 * itself is built by {@link buildCoursePicker}; this module decides when it is shown again.
 */
import { buildCoursePicker, type CoursePickerIntent } from './course-picker.js';
import { readProgressLines } from './course-progress-lines.js';
import { keyOf } from './courses-roots.js';
import type { CourseScans } from './course-list-cache.js';
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shows the picker and resolves with the intent the learner picked, or `undefined` when they
 * closed it. A scan still running then goes on, and is cached when it ends.
 */
export async function showCoursePicker(
  session: CoursePickerSession,
): Promise<CoursePickerIntent | undefined> {
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
  let closed = false;
  /** Counts what is shown (redraws) and what is asked for (scans): only the latest counts. */
  let drawn = 0;
  let newestScan = 0;

  const view = () =>
    buildCoursePicker({
      hasRoots: roots.length > 0,
      courses,
      recent: recentShown,
      openFolder: session.openFolder(),
      scanning: scanning || reading > 0 || checking > 0,
      progressLines: lines,
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
        message: `Could not look at the Recent Courses: ${describe(error)}`,
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
      const found = await readProgressLines(ports, folders, () => closed);
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

  const picker = ports.ui.openPicker(view(), (button) => {
    if (button.type === 'refreshCourses') {
      scanning = true;
      asked.clear();
      drawn += 1;
      picker.update(view());
      void showScan(scans.scan(roots, recent, { fresh: true }));
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
