/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */
import { basename } from 'node:path';

import type { Course, Outline, Section } from './course-model.js';
import { resourcePath, type ResourceRecord, type ResourcesData } from './resources.js';

export interface ResourceNode {
  readonly kind: 'resource';
  /** Stable across sessions: what a click passes to `openResource`. */
  readonly id: string;
  /** The file's name. */
  readonly label: string;
  /** The file's full path. */
  readonly path: string;
  /** Whether the file is no longer where the Resource points: the tree shows it dimmed. */
  readonly missing: boolean;
}

export type LessonTreeNode =
  | {
      readonly kind: 'lesson';
      /** The Lesson's id: its path in the Course. */
      readonly id: string;
      readonly label: string;
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

export interface LessonTreeModel {
  /** Shown instead of the tree, when there is nothing to list. */
  readonly message?: string;
  /** The Course node, the first node of the tree; absent when the Course has no Lessons. */
  readonly course?: CourseNode;
  readonly nodes: readonly LessonTreeNode[];
}

/** What the tree is built from: the Course and what is attached to its Lessons. */
interface TreeSource {
  readonly folder: string;
  readonly resources: ResourcesData;
  /** The ids of the Resources whose file is not where they point. */
  readonly missing: ReadonlySet<string>;
}

function resourceNode(source: TreeSource, record: ResourceRecord): ResourceNode {
  const path = resourcePath(source.folder, record);
  return {
    id: record.id,
    kind: 'resource',
    label: basename(path),
    path,
    missing: source.missing.has(record.id),
  };
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
    ...outline.lessons.map((lesson): LessonTreeNode => ({
      id: lesson.id,
      kind: 'lesson',
      label: lesson.title,
      resources: (source.resources.lessons[lesson.id] ?? []).map((record) =>
        resourceNode(source, record),
      ),
    })),
    ...outline.sections.map((section) => nodeOf(section, source)),
  ];
}

export function buildLessonTree(
  course: Course,
  resources: ResourcesData,
  missing: ReadonlySet<string>,
): LessonTreeModel {
  const source: TreeSource = { folder: course.folder, resources, missing };
  return {
    course: {
      kind: 'course',
      id: courseNodeId,
      label: basename(course.folder),
      resources: resources.course.map((record) => resourceNode(source, record)),
    },
    nodes: nodesOf(course, source),
  };
}
