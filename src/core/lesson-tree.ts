/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */
import { basename } from 'node:path';

import { lessonsInOrder, type Course, type Outline, type Section } from './course-model.js';
import type { LessonStatus } from './lesson-status.js';
import { lessonEntry, lessonStatus, type CourseProgress } from './progress.js';
import { resourcePath, type ResourcesData } from './resources.js';
import { formatClock } from './status-bar.js';

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
  /** The file's name. */
  readonly label: string;
  /** The file's full path. */
  readonly path: string;
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
  /** The Course's totals; absent when the Course has no Lessons. */
  readonly summary?: CourseSummary;
  readonly nodes: readonly LessonTreeNode[];
}

/** What the tree is built from: the Course and what is attached to its Lessons. */
interface TreeSource {
  readonly folder: string;
  readonly resources: ResourcesData;
  readonly progress: CourseProgress;
}

/** `12:30 / 40:05`: where the Lesson was saved and how long it is; just the position while its length is unknown. */
function playhead(progress: CourseProgress, lessonId: string): string {
  const saved = lessonEntry(progress.lessons, lessonId);
  if (saved === undefined) {
    return '';
  }
  return saved.duration > 0
    ? `${formatClock(saved.position)} / ${formatClock(saved.duration)}`
    : formatClock(saved.position);
}

/** How many of the Lessons under `outline` are done, and how many there are. */
function totalsOf(outline: Outline, progress: CourseProgress): { done: number; total: number } {
  const lessons = lessonsInOrder(outline);
  return {
    done: lessons.filter((lesson) => lessonStatus(progress, lesson.id) === 'done').length,
    total: lessons.length,
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
    description: `${String(done)}/${String(total)}`,
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
        description: status === 'inProgress' ? playhead(source.progress, lesson.id) : '',
        resources: (source.resources.lessons[lesson.id] ?? []).map((record): ResourceNode => {
          const path = resourcePath(source.folder, record);
          return { id: record.id, kind: 'resource', label: basename(path), path };
        }),
      };
    }),
    ...outline.sections.map((section) => nodeOf(section, source)),
  ];
}

/**
 * The Lesson tree of a Course: a pure function of the Course, what is attached to it and its
 * Progress. The states come from `lessonStatus`; nothing here decides what done means (ADR 0030).
 */
export function buildLessonTree(
  course: Course,
  resources: ResourcesData,
  progress: CourseProgress,
): LessonTreeModel {
  const { done, total } = totalsOf(course, progress);
  const percent = Math.floor((done * 100) / total);
  return {
    summary: {
      done,
      total,
      percent,
      description: `${String(done)}/${String(total)} · ${String(percent)}%`,
    },
    nodes: nodesOf(course, { folder: course.folder, resources, progress }),
  };
}
