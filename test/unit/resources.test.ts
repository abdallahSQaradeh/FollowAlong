import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';

/** The Lesson with this id, wherever it sits in the tree the learner sees. */
function lessonNode(h: Harness, lessonId: string): LessonTreeNode | undefined {
  const find = (nodes: readonly LessonTreeNode[]): LessonTreeNode | undefined => {
    for (const node of nodes) {
      if (node.kind === 'lesson' && node.id === lessonId) {
        return node;
      }
      if (node.kind === 'section') {
        const found = find(node.children);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return find(h.ui.lessonTree?.nodes ?? []);
}

/** The labels of the Resources shown under a Lesson. */
function resourceLabels(h: Harness, lessonId: string): string[] {
  const node = lessonNode(h, lessonId);
  return node?.kind === 'lesson' ? node.resources.map((resource) => resource.label) : [];
}

describe('attaching a file Resource to a Lesson', () => {
  it('shows the file under its Lesson in the tree', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Section 1/01 Welcome.webm': 'video',
      'Section 1/02 Setup.webm': 'video',
      'Section 1/notes/cheat sheet.md': '# cheat sheet',
    });
    await h.core.openCourse(course);

    await h.core.attachResource(
      'Section 1/01 Welcome.webm',
      `${course}/Section 1/notes/cheat sheet.md`,
    );

    expect(resourceLabels(h, 'Section 1/01 Welcome.webm')).toEqual(['cheat sheet.md']);
    expect(resourceLabels(h, 'Section 1/02 Setup.webm')).toEqual([]);
  });
});
