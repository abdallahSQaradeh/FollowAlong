/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */
import { basename } from 'node:path';

import { lessonsInOrder, type Course, type Outline, type Section } from './course-model.js';
import type { LessonStatus } from './lesson-status.js';
import { lessonEntry, lessonStatus, type CourseProgress } from './progress.js';
import { resourcePath, urlLabel, type ResourceRecord, type ResourcesData } from './resources.js';
import { formatClock } from './clock-text.js';

/** The mark before a Lesson in the tree, by its state (spec #12, story 86). */
export const lessonGlyphs: Readonly<Record<LessonStatus, string>> = {
  done: '✓',
  inProgress: '◐',
  notStarted: '○',
};

export interface ResourceNode {
  readonly kind: 'resource';
  /** Stable across sessions: what a click passes to `openResource`. */
  readonly id: string;
  /** A file on disk, or a web page (ADR 0047). */
  readonly type: 'file' | 'url';
  /** The file's name, or the web page's address without its scheme. */
  readonly label: string;
  /** The file's full path, or the web page's address. */
  readonly path: string;
  /**
   * Whether the file is no longer where the Resource points: the tree shows it dimmed. Never true
   * for a URL, which has no file to lose.
   */
  readonly missing: boolean;
}

export type LessonTreeNode =
  | {
      readonly kind: 'lesson';
      /** The Lesson's id: its path in the Course. */
      readonly id: string;
      readonly label: string;
      /** Where the Lesson is in the Course's Progress (ADR 0030). */
      readonly status: LessonStatus;
      /** The mark for `status`: ✓ done, ◐ in progress, ○ not started. */
      readonly glyph: string;
      /** Shown beside the label: `12:30 / 40:05` for a Lesson in progress, else empty. */
      readonly description: string;
      /** The Lesson's Resources, in the order they were attached. */
      readonly resources: readonly ResourceNode[];
    }
  | ResourceNode
  | {
      readonly kind: 'section';
      /** The Section's folder path in the Course, ending in `/`. */
      readonly id: string;
      readonly label: string;
      /** How many of the Lessons in the Section, nested Sections included, are done. */
      readonly done: number;
      /** How many Lessons the Section holds, nested Sections included. */
      readonly total: number;
      /** Shown beside the label: `3/12`. */
      readonly description: string;
      /** The Section's Lessons, then its nested Sections. */
      readonly children: readonly LessonTreeNode[];
    };

/**
 * The Course itself, shown above the Sections and Lessons: it carries the Resources of the whole
 * Course, and the "+" that attaches one.
 */
export interface CourseNode {
  readonly kind: 'course';
  /** Never the id of a Lesson (a file name) or of a Section (it ends in `/`). */
  readonly id: typeof courseNodeId;
  /** The Course's name: its folder's name. */
  readonly label: string;
  /** The Course's Resources, in the order they were attached. */
  readonly resources: readonly ResourceNode[];
}

/** The id of the Course node: what the "+" on it passes to the attach command. */
export const courseNodeId = '<course>';

/** How far the learner is through the whole Course (spec #12, story 86). */
export interface CourseSummary {
  readonly done: number;
  readonly total: number;
  /** `done` of `total`, rounded down: 100 only when every Lesson is done. */
  readonly percent: number;
  /** Shown beside the tree's title: `27/140 · 19%`. */
  readonly description: string;
}

export interface LessonTreeModel {
  /** Shown instead of the tree, when there is nothing to list. */
  readonly message?: string;
  /** The Course node, the first node of the tree; absent when the Course has no Lessons. */
  readonly course?: CourseNode;
  /** The Course's totals; absent when the Course has no Lessons. */
  readonly summary?: CourseSummary;
  readonly nodes: readonly LessonTreeNode[];
}

/** What the tree is built from: the Course and what is attached to its Lessons. */
interface TreeSource {
  readonly folder: string;
  readonly resources: ResourcesData;
  /** The ids of the Resources whose file is not where they point. */
  readonly missing: ReadonlySet<string>;
  readonly progress: CourseProgress;
}

function resourceNode(source: TreeSource, record: ResourceRecord): ResourceNode {
  if (record.kind === 'url') {
    return {
      id: record.id,
      kind: 'resource',
      type: 'url',
      label: urlLabel(record.url),
      path: record.url,
      missing: false,
    };
  }
  const path = resourcePath(source.folder, record);
  return {
    id: record.id,
    kind: 'resource',
    type: 'file',
    label: basename(path),
    path,
    missing: source.missing.has(record.id),
  };
}

/** `12:30 / 40:05`: where the Lesson was saved and how long it is; just the position while its length is unknown. */
function playheadText(progress: CourseProgress, lessonId: string): string {
  const saved = lessonEntry(progress.lessons, lessonId);
  if (saved === undefined) {
    return '';
  }
  return saved.duration > 0
    ? `${formatClock(saved.position)} / ${formatClock(saved.duration)}`
    : formatClock(saved.position);
}

/** `3/12`: how many of the Lessons are done, of how many. */
function fraction(done: number, total: number): string {
  return `${String(done)}/${String(total)}`;
}

/** How many of the Lessons under `outline` are done, and how many there are. */
export function totalsOf(
  outline: Outline,
  progress: CourseProgress,
): { done: number; total: number } {
  const lessons = lessonsInOrder(outline);
  return {
    done: lessons.filter((lesson) => lessonStatus(progress, lesson.id) === 'done').length,
    total: lessons.length,
  };
}

/**
 * How far through the Course the learner is: the one rule for `27/140 · 19%`, used by the tree and
 * the Course picker alike. `total` is at least 1.
 */
export function summaryOf({ done, total }: { done: number; total: number }): CourseSummary {
  const percent = Math.floor((done * 100) / total);
  return {
    done,
    total,
    percent,
    description: `${fraction(done, total)} · ${String(percent)}%`,
  };
}

function nodeOf(section: Section, source: TreeSource): LessonTreeNode {
  const { done, total } = totalsOf(section, source.progress);
  return {
    id: section.id,
    kind: 'section',
    label: section.name,
    done,
    total,
    description: fraction(done, total),
    children: nodesOf(section, source),
  };
}

function nodesOf(outline: Outline, source: TreeSource): LessonTreeNode[] {
  return [
    ...outline.lessons.map((lesson): LessonTreeNode => {
      const status = lessonStatus(source.progress, lesson.id);
      return {
        id: lesson.id,
        kind: 'lesson',
        label: lesson.title,
        status,
        glyph: lessonGlyphs[status],
        description: status === 'inProgress' ? playheadText(source.progress, lesson.id) : '',
        resources: (source.resources.lessons[lesson.id] ?? []).map((record) =>
          resourceNode(source, record),
        ),
      };
    }),
    ...outline.sections.map((section) => nodeOf(section, source)),
  ];
}

/**
 * The Lesson tree of a Course: a pure function of the Course, what is attached to it (and which
 * of that is missing) and its Progress. The states come from `lessonStatus`; nothing here decides
 * what done means (ADR 0030). Only called for a Course with at least one Lesson.
 */
export function buildLessonTree(
  course: Course,
  resources: ResourcesData,
  progress: CourseProgress,
  missing: ReadonlySet<string>,
): LessonTreeModel {
  const source: TreeSource = { folder: course.folder, resources, missing, progress };
  return {
    course: {
      kind: 'course',
      id: courseNodeId,
      label: basename(course.folder),
      resources: resources.course.map((record) => resourceNode(source, record)),
    },
    summary: summaryOf(totalsOf(course, progress)),
    nodes: nodesOf(course, source),
  };
}
