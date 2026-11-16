/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */
import type { Course, Outline, Section } from './course-model.js';

export type LessonTreeNode =
  | {
      readonly kind: 'lesson';
      /** The Lesson's id: its path in the Course. */
      readonly id: string;
      readonly label: string;
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

function nodeOf(section: Section): LessonTreeNode {
  return {
    id: section.id,
    kind: 'section',
    label: section.name,
    children: nodesOf(section),
  };
}

function nodesOf(outline: Outline): LessonTreeNode[] {
  return [
    ...outline.lessons.map((lesson): LessonTreeNode => ({
      id: lesson.id,
      kind: 'lesson',
      label: lesson.title,
    })),
    ...outline.sections.map(nodeOf),
  ];
}

export function buildLessonTree(course: Course): LessonTreeModel {
  return { nodes: nodesOf(course) };
}
