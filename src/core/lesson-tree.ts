/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */
import { basename } from 'node:path';

import type { Course, Outline, Section } from './course-model.js';
import { resourcePath, type ResourcesData } from './resources.js';

export type LessonTreeNode =
  | {
      readonly kind: 'lesson';
      /** The Lesson's id: its path in the Course. */
      readonly id: string;
      readonly label: string;
      /** The Lesson's Resources, in the order they were attached. */
      readonly resources: readonly LessonTreeNode[];
    }
  | {
      readonly kind: 'resource';
      /** Stable across sessions: what a click passes to `openResource`. */
      readonly id: string;
      /** The file's name. */
      readonly label: string;
      /** The file's full path. */
      readonly tooltip: string;
    }
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

export function buildLessonTree(course: Course, resources: ResourcesData): LessonTreeModel {
  const nodeOf = (section: Section): LessonTreeNode => ({
    id: section.id,
    kind: 'section',
    label: section.name,
    children: nodesOf(section),
  });
  const nodesOf = (outline: Outline): LessonTreeNode[] => [
    ...outline.lessons.map((lesson): LessonTreeNode => ({
      id: lesson.id,
      kind: 'lesson',
      label: lesson.title,
      resources: (resources.lessons[lesson.id] ?? []).map((record): LessonTreeNode => {
        const path = resourcePath(course.folder, record);
        return { id: record.id, kind: 'resource', label: basename(path), tooltip: path };
      }),
    })),
    ...outline.sections.map(nodeOf),
  ];
  return { nodes: nodesOf(course) };
}
