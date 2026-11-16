/**
 * The Course picker (spec #12, Core modules → Course picker / Lesson picker models): a pure
 * function from the scanned Courses to the quick pick behind “Open Course…”. Picking returns an
 * intent; the core carries it out.
 */
import type { ScannedCourse } from './course-scanner.js';
import type { QuickPickEntry, QuickPickModel } from './quick-pick.js';

/** What picking an item of the Course picker asks the core to do. */
export type CoursePickerIntent =
  { readonly type: 'openCourse'; readonly folder: string } | { readonly type: 'addCoursesRoot' };

type Entry = QuickPickEntry<CoursePickerIntent>;

export interface CoursePickerInput {
  /** Whether the learner has named any Courses root. */
  readonly hasRoots: boolean;
  /** The Courses the scan found, in the order to show them (A–Z). */
  readonly courses: readonly ScannedCourse[];
}

function placeholderOf({ hasRoots, courses }: CoursePickerInput): string {
  if (!hasRoots) {
    return 'Add a Courses root: a folder that holds your Courses';
  }
  return courses.length === 0
    ? 'No Courses found under your Courses roots'
    : 'Type a Course name to open it';
}

export function buildCoursePicker(input: CoursePickerInput): QuickPickModel<CoursePickerIntent> {
  const courses = input.courses.map((course): Entry => ({
    kind: 'item',
    label: course.name,
    ...(course.categories.length === 0 ? {} : { description: course.categories.join(' / ') }),
    intent: { type: 'openCourse', folder: course.folder },
  }));
  return {
    title: 'Open Course',
    placeholder: placeholderOf(input),
    // The category path is the description, and typing matches it (story 7).
    matchOnDescription: true,
    entries: [
      ...courses,
      { kind: 'item', label: 'Add Courses root…', intent: { type: 'addCoursesRoot' } },
    ],
  };
}
