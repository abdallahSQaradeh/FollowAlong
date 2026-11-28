/**
 * The Lesson picker (spec #12, Core modules → Course picker / Lesson picker models): a pure
 * function from the open Course to the quick pick behind “Go to Lesson…”. Lessons are grouped
 * under a separator for their Section, and each item shows its Section so that typing a Section
 * name narrows the list to it.
 */
import { formatClock } from './clock-text.js';
import type { Lesson, Outline } from './course-model.js';
import { knownLength, lessonGlyphs, playheadText, type LessonLengths } from './lesson-tree.js';
import { lessonStatus, type CourseProgress } from './progress.js';
import type { QuickPickEntry, QuickPickModel } from './quick-pick.js';

/**
 * What picking an item of the Lesson picker asks the core to do. The picker only says what the
 * learner wants; where the Lesson starts is the core's rule (ADR 0010, 0030).
 */
export type LessonPickerIntent =
  /** Plays the Lesson where the learner left off. */
  | { readonly type: 'playLesson'; readonly lessonId: string }
  /** Plays the Lesson from 0:00 (the item's Start from beginning button). */
  | { readonly type: 'playLessonFromStart'; readonly lessonId: string };

type Entry = QuickPickEntry<LessonPickerIntent>;

/** Where the picker finds a Lesson's length: its Progress, then the lengths found otherwise. */
interface Lengths {
  readonly progress: CourseProgress;
  readonly lengths: LessonLengths;
}

/** `12:30 / 40:05` for a Lesson in progress; `40:05` for any other Lesson whose length is known. */
function lengthText({ progress, lengths }: Lengths, lessonId: string): string {
  if (lessonStatus(progress, lessonId) === 'inProgress') {
    return playheadText(progress, lengths, lessonId);
  }
  const length = knownLength(progress, lengths, lessonId);
  return length === undefined ? '' : formatClock(length);
}

/** A Section shown by its path, so same-named Sections in different places stay apart. */
function sectionLabel(sectionPath: readonly string[]): string {
  return sectionPath.join(' / ');
}

/**
 * A Lesson's line: its state glyph before the title, and beside it the Section and the length, or
 * for a Lesson in progress the saved position and the length. The glyph and the position come from
 * the same rules as the Lesson tree (ADR 0030); the Section stays in the description, which typing
 * matches. An unknown length shows nothing (ADR 0109).
 */
function itemOf(lesson: Lesson, sectionPath: readonly string[], known: Lengths): Entry {
  const status = lessonStatus(known.progress, lesson.id);
  const length = lengthText(known, lesson.id);
  const description = [...(sectionPath.length > 0 ? [sectionLabel(sectionPath)] : []), length]
    .filter((part) => part !== '')
    .join('  ·  ');
  return {
    kind: 'item',
    label: `${lessonGlyphs[status]} ${lesson.title}`,
    ...(description === '' ? {} : { description }),
    intent: { type: 'playLesson', lessonId: lesson.id },
    buttons: [
      {
        label: 'Start from beginning',
        icon: 'debug-restart',
        intent: { type: 'playLessonFromStart', lessonId: lesson.id },
      },
    ],
  };
}

function entriesOf(outline: Outline, sectionPath: readonly string[], known: Lengths): Entry[] {
  const own = outline.lessons.map((lesson) => itemOf(lesson, sectionPath, known));
  const heading: Entry[] =
    sectionPath.length > 0 && own.length > 0
      ? [{ kind: 'separator', label: sectionLabel(sectionPath) }]
      : [];
  return [
    ...heading,
    ...own,
    ...outline.sections.flatMap((section) =>
      entriesOf(section, [...sectionPath, section.name], known),
    ),
  ];
}

/**
 * The picker for the open Course. `lengths` holds the Lesson lengths found other than by playing
 * (ADR 0109); a length in Progress wins over it.
 */
export function buildLessonPicker(
  course: Outline,
  progress: CourseProgress,
  lengths: LessonLengths = new Map(),
): QuickPickModel<LessonPickerIntent> {
  return {
    title: 'Go to Lesson',
    placeholder: 'Type a Lesson title or a Section name',
    matchOnDescription: true,
    entries: entriesOf(course, [], { progress, lengths }),
  };
}
