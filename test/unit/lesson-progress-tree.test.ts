import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';

/** Every node of the tree the learner sees, in tree order, whatever its depth. */
function allNodes(h: Harness): LessonTreeNode[] {
  const walk = (nodes: readonly LessonTreeNode[]): LessonTreeNode[] =>
    nodes.flatMap((node) => [node, ...(node.kind === 'section' ? walk(node.children) : [])]);
  return walk(h.ui.lessonTree?.nodes ?? []);
}

/** The Lesson nodes' glyphs by Lesson id, as the learner reads them in the tree. */
function glyphs(h: Harness): Record<string, string> {
  return Object.fromEntries(
    allNodes(h).flatMap((node) => (node.kind === 'lesson' ? [[node.id, node.glyph]] : [])),
  );
}

/** The player plays the Lesson from 0:00 up to `until` seconds, reporting every 2 s (600 s long). */
function playUntil(h: Harness, lessonId: string, until: number): void {
  h.player.emit({ type: 'played', lessonId });
  for (let position = 0; position <= until; position += 2) {
    h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
  }
}

function pause(h: Harness, lessonId: string): void {
  h.player.emit({ type: 'paused', lessonId, byUser: true });
}

/** VS Code starts again and the learner opens the Course. */
async function reopen(h: Harness, course: string): Promise<void> {
  await h.settle();
  h.restart();
  await h.core.openCourse(course);
  h.player.ready();
}

const threeLessons = {
  '01 Intro.webm': 'video',
  '02 Setup.webm': 'video',
  '03 Closures.webm': 'video',
};

describe('Progress in the Lesson tree', () => {
  it('shows ✓ for a done Lesson, ◐ for one in progress and ○ for one not started', async () => {
    const h = await createHarness();
    const course = await h.folder('course', threeLessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('01 Intro.webm');
    playUntil(h, '01 Intro.webm', 580);
    pause(h, '01 Intro.webm');
    h.core.playLesson('02 Setup.webm');
    playUntil(h, '02 Setup.webm', 12);
    pause(h, '02 Setup.webm');

    await reopen(h, course);

    expect(glyphs(h)).toEqual({
      '01 Intro.webm': '✓',
      '02 Setup.webm': '◐',
      '03 Closures.webm': '○',
    });
  });
});
