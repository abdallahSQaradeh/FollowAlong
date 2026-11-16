/**
 * The Lesson picker (spec #12, Core modules → Course picker / Lesson picker models): a pure
 * function from the open Course to the quick pick behind “Go to Lesson…”. Lessons are grouped
 * under a separator for their Section, and each item shows its Section so that typing a Section
 * name narrows the list to it.
 */
import type { Lesson, Outline } from './course-model.js';
import type { QuickPickModel } from './quick-pick.js';

/** What picking an item of the Lesson picker asks the core to do. */
export interface LessonPickerIntent {
  readonly type: 'playLesson';
  readonly lessonId: string;
}

type Entry = QuickPickModel<LessonPickerIntent>['entries'][number];

function itemOf(lesson: Lesson, sectionPath: readonly string[]): Entry {
  return {
    kind: 'item',
    label: lesson.title,
    ...(sectionPath.length > 0 ? { description: sectionPath.join(' / ') } : {}),
    intent: { type: 'playLesson', lessonId: lesson.id },
  };
}

function entriesOf(outline: Outline, sectionPath: readonly string[]): Entry[] {
  const own = outline.lessons.map((lesson) => itemOf(lesson, sectionPath));
  const heading: Entry[] =
    sectionPath.length > 0 && own.length > 0
      ? [{ kind: 'separator', label: sectionPath.join(' / ') }]
      : [];
  return [
    ...heading,
    ...own,
    ...outline.sections.flatMap((section) => entriesOf(section, [...sectionPath, section.name])),
  ];
}

export function buildLessonPicker(course: Outline): QuickPickModel<LessonPickerIntent> {
  return {
    title: 'Go to Lesson',
    placeholder: 'Type a Lesson title or a Section name',
    matchOnDescription: true,
    entries: entriesOf(course, []),
  };
}
