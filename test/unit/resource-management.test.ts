import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode, ResourceNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';

/** The Resources shown under a Lesson, as the learner sees them in the tree. */
function resourceNodes(h: Harness, lessonId: string): readonly ResourceNode[] {
  const find = (nodes: readonly LessonTreeNode[]): readonly ResourceNode[] | undefined => {
    for (const node of nodes) {
      if (node.kind === 'lesson' && node.id === lessonId) {
        return node.resources;
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
  const nodes = find(h.ui.lessonTree?.nodes ?? []);
  if (nodes === undefined) {
    throw new Error(`The tree shows no Lesson ${lessonId}`);
  }
  return nodes;
}

/** The Resource under a Lesson with this label. */
function resourceNamed(h: Harness, lessonId: string, label: string): ResourceNode {
  const node = resourceNodes(h, lessonId).find((resource) => resource.label === label);
  if (node === undefined) {
    throw new Error(`${lessonId} shows no Resource ${label}`);
  }
  return node;
}

describe('a Resource whose file is missing', () => {
  it('shows dimmed in the tree when the Course opens, the others as usual', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'notes.md': '# notes',
      'cheat.md': '# cheat',
    });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    await h.core.attachResource('intro.webm', join(course, 'cheat.md'));
    await rm(join(course, 'notes.md'));

    await h.core.openCourse(course);

    expect(resourceNamed(h, 'intro.webm', 'notes.md').missing).toBe(true);
    expect(resourceNamed(h, 'intro.webm', 'cheat.md').missing).toBe(false);
  });
});
