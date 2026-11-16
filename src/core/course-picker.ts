/**
 * The Course picker (spec #12, Core modules → Course picker / Lesson picker models): a pure
 * function from the scanned Courses and the Recent Courses to the quick pick behind “Open
 * Course…”. Picking returns an intent; the core carries it out.
 */
import { keyOf, sameFolder } from './courses-roots.js';
import type { ScannedCourse } from './course-scanner.js';
import type { QuickPickEntry, QuickPickModel } from './quick-pick.js';

/** What picking an item, or pressing a button, of the Course picker asks the core to do. */
export type CoursePickerIntent =
  | { readonly type: 'openCourse'; readonly folder: string }
  | { readonly type: 'addCoursesRoot' }
  /** Asks for the new folder of a Recent Course that moved, and re-points the entry to it. */
  | { readonly type: 'locateCourse'; readonly folder: string }
  /** Drops a Course from Recent. */
  | { readonly type: 'removeRecentCourse'; readonly folder: string }
  /** Rescans the Courses roots at once, so a Course just downloaded shows up (Refresh). */
  | { readonly type: 'refreshCourses' }
  /** Walks folders inside the picker (Browse…, ADR 0066): the picker stays open. */
  | { readonly type: 'browse' };

type Entry = QuickPickEntry<CoursePickerIntent>;

/** A Recent Course, as the picker shows it. */
export interface RecentCourse {
  readonly name: string;
  readonly categories: readonly string[];
  readonly folder: string;
  /** Whether its folder is gone (moved, renamed, or on a drive that is not there). */
  readonly missing: boolean;
}

export interface CoursePickerInput {
  /** Whether the learner has named any Courses root. */
  readonly hasRoots: boolean;
  /** The Courses the scan found, in the order to show them (A–Z). */
  readonly courses: readonly ScannedCourse[];
  /** The Recent Courses, newest first: shown above the others. */
  readonly recent: readonly RecentCourse[];
  /** The folder of the Course open in this window, if any: it is tagged (open). */
  readonly openFolder: string | undefined;
  /**
   * Whether a scan of the Courses roots is still running: `courses` is then what the last scan
   * found (the cache), or nothing yet, and the picker shows it is busy.
   */
  readonly scanning: boolean;
  /**
   * The Progress line of each Course read so far, by {@link keyOf} its folder: shown under the
   * Course's name. A Course not in it has none (yet).
   */
  readonly progressLines?: ReadonlyMap<string, string | undefined>;
}

function placeholderOf({ hasRoots, courses, recent, scanning }: CoursePickerInput): string {
  if (recent.length > 0) {
    return 'Type a Course name to open it';
  }
  if (!hasRoots) {
    return 'Add a Courses root: a folder that holds your Courses';
  }
  if (courses.length === 0) {
    return scanning
      ? 'Looking for Courses under your Courses roots…'
      : 'No Courses found under your Courses roots';
  }
  return 'Type a Course name to open it';
}

export function buildCoursePicker(input: CoursePickerInput): QuickPickModel<CoursePickerIntent> {
  const isOpen = (folder: string): boolean =>
    input.openFolder !== undefined && sameFolder(input.openFolder, folder);
  const description = (categories: readonly string[], folder: string, missing: boolean) => {
    const parts = [
      ...(categories.length === 0 ? [] : [categories.join(' / ')]),
      ...(isOpen(folder) ? ['(open)'] : []),
      ...(missing ? ['missing'] : []),
    ];
    return parts.length === 0 ? {} : { description: parts.join(' · ') };
  };
  const detail = (folder: string, missing: boolean) => {
    const line = missing ? undefined : input.progressLines?.get(keyOf(folder));
    return line === undefined ? {} : { detail: line };
  };
  const recent = input.recent.map((course): Entry => ({
    kind: 'item',
    label: course.name,
    ...description(course.categories, course.folder, course.missing),
    ...detail(course.folder, course.missing),
    intent: course.missing
      ? { type: 'locateCourse', folder: course.folder }
      : { type: 'openCourse', folder: course.folder },
    ...(course.missing
      ? {
          buttons: [
            {
              label: 'Locate…',
              icon: 'folder-opened',
              intent: { type: 'locateCourse', folder: course.folder },
            },
            {
              label: 'Remove',
              icon: 'trash',
              intent: { type: 'removeRecentCourse', folder: course.folder },
            },
          ],
        }
      : {}),
  }));
  // A Recent Course is listed once, in Recent: the A–Z list is for the Courses not opened lately.
  const recentKeys = new Set(input.recent.map((course) => keyOf(course.folder)));
  const others = input.courses
    .filter((course) => !recentKeys.has(keyOf(course.folder)))
    .map((course): Entry => ({
      kind: 'item',
      label: course.name,
      ...description(course.categories, course.folder, false),
      ...detail(course.folder, false),
      intent: { type: 'openCourse', folder: course.folder },
    }));
  return {
    title: 'Open Course',
    placeholder: placeholderOf(input),
    // The category path is the description, and typing matches it (story 7).
    matchOnDescription: true,
    ...(input.scanning ? { busy: true } : {}),
    toolbar: [{ label: 'Refresh', icon: 'refresh', intent: { type: 'refreshCourses' } }],
    entries: [
      ...(recent.length === 0 ? [] : [{ kind: 'separator', label: 'Recent Courses' } as const]),
      ...recent,
      ...(recent.length === 0 || others.length === 0
        ? []
        : [{ kind: 'separator', label: 'Other Courses' } as const]),
      ...others,
      { kind: 'item', label: 'Browse…', intent: { type: 'browse' }, keepsOpen: true },
      { kind: 'item', label: 'Add Courses root…', intent: { type: 'addCoursesRoot' } },
    ],
  };
}
