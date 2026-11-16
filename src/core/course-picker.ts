/**
 * The Course picker (spec #12, Core modules → Course picker / Lesson picker models): a pure
 * function from the scanned Courses to the quick pick behind “Open Course…”. Picking returns an
 * intent; the core carries it out.
 */
import type { QuickPickEntry, QuickPickModel } from './quick-pick.js';

/** What picking an item of the Course picker asks the core to do. */
export interface CoursePickerIntent {
  readonly type: 'addCoursesRoot';
}

export function buildCoursePicker(): QuickPickModel<CoursePickerIntent> {
  const entries: QuickPickEntry<CoursePickerIntent>[] = [
    { kind: 'item', label: 'Add Courses root…', intent: { type: 'addCoursesRoot' } },
  ];
  return {
    title: 'Open Course',
    placeholder: 'Add a Courses root: a folder that holds your Courses',
    matchOnDescription: false,
    entries,
  };
}
