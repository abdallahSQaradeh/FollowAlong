/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */
import { basename } from 'node:path';

import type { Course, Outline, Section } from './course-model.js';
import { resourcePath, type ResourcesData } from './resources.js';

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

export interface LessonTreeModel {
  /** Shown instead of the tree, when there is nothing to list. */
  readonly message?: string;
  readonly nodes: readonly LessonTreeNode[];
}

/** What the tree is built from: the Course and what is attached to its Lessons. */
interface TreeSource {
  readonly folder: string;
  readonly resources: ResourcesData;
  /** The ids of the Resources whose file is not where they point. */
  readonly missing: ReadonlySet<string>;
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
      resources: (source.resources.lessons[lesson.id] ?? []).map((record): ResourceNode => {
        const path = resourcePath(source.folder, record);
        return {
          id: record.id,
          kind: 'resource',
          label: basename(path),
          path,
          missing: source.missing.has(record.id),
        };
      }),
    })),
    ...outline.sections.map((section) => nodeOf(section, source)),
  ];
}

export function buildLessonTree(
  course: Course,
  resources: ResourcesData,
  missing: ReadonlySet<string>,
): LessonTreeModel {
  return { nodes: nodesOf(course, { folder: course.folder, resources, missing }) };
}
