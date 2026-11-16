/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */
import { basename } from 'node:path';

import type { Course, Outline, Section } from './course-model.js';
import type { LessonStatus } from './lesson-status.js';
import { lessonStatus, type CourseProgress } from './progress.js';
import { resourcePath, type ResourcesData } from './resources.js';

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
      /** The Lesson's Resources, in the order they were attached. */
      readonly resources: readonly ResourceNode[];
    }
  | ResourceNode
  | {
      readonly kind: 'section';
      /** The Section's folder path in the Course, ending in `/`. */
      readonly id: string;
      readonly label: string;
      /** The Section's Lessons, then its nested Sections. */
      readonly children: readonly LessonTreeNode[];
    };

export interface LessonTreeModel {
  /** Shown instead of the tree, when there is nothing to list. */
  readonly message?: string;
  readonly nodes: readonly LessonTreeNode[];
}

/** What the tree is built from: the Course and what is attached to its Lessons. */
interface TreeSource {
  readonly folder: string;
  readonly resources: ResourcesData;
  readonly progress: CourseProgress;
}

function nodeOf(section: Section, source: TreeSource): LessonTreeNode {
  return {
    id: section.id,
    kind: 'section',
    label: section.name,
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
  return { nodes: nodesOf(course, { folder: course.folder, resources, progress }) };
}
