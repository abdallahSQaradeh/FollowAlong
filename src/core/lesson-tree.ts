/**
 * The Lesson tree as a view model for the UI sink: Sections → Lessons, or a message when the
 * folder holds no Lessons. The adapter turns it into the FollowAlong tree view in the activity bar.
 */

export interface LessonTreeNode {
  /** A Lesson's id (its path in the Course), or a Section's folder path ending in `/`. */
  readonly id: string;
  readonly kind: 'section' | 'lesson';
  readonly label: string;
  /** A Section's Lessons and nested Sections; always absent on a Lesson. */
  readonly children?: readonly LessonTreeNode[];
}

export interface LessonTreeModel {
  /** Shown instead of the tree, when there is nothing to list. */
  readonly message?: string;
  readonly nodes: readonly LessonTreeNode[];
}
