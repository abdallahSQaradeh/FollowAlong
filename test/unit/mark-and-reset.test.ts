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

/** The text shown beside the Section or Lesson with this id. */
function descriptionOf(h: Harness, id: string): string | undefined {
  for (const node of allNodes(h)) {
    if (node.kind !== 'resource' && node.id === id) {
      return node.description;
    }
  }
  return undefined;
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

/** VS Code starts again and the learner opens the Course; returns the `load` the player gets. */
async function reopen(h: Harness, course: string) {
  await h.settle();
  h.restart();
  h.clock.advance(60_000);
  await h.core.openCourse(course);
  h.player.ready();
  return h.player.sent.at(-1);
}

const twoSections = {
  'Basics/01 Intro.webm': 'video',
  'Basics/02 Setup.webm': 'video',
  'Advanced/03 Closures.webm': 'video',
  'Advanced/04 Prototypes.webm': 'video',
};

/** Opens a Course of two Sections, with Lesson 01 played to 5 min and Lesson 03 to 12 s. */
async function openWithProgress(h: Harness): Promise<string> {
  const course = await h.folder('course', twoSections);
  await h.core.openCourse(course);
  h.player.ready();
  h.core.playLesson('Basics/01 Intro.webm');
  playUntil(h, 'Basics/01 Intro.webm', 300);
  pause(h, 'Basics/01 Intro.webm');
  h.core.playLesson('Advanced/03 Closures.webm');
  playUntil(h, 'Advanced/03 Closures.webm', 12);
  pause(h, 'Advanced/03 Closures.webm');
  return course;
}

describe('Mark all done', () => {
  it('marks every Lesson of the Section done, and no Lesson of another Section', async () => {
    const h = await createHarness();
    await openWithProgress(h);

    await h.core.markSectionDone('Basics/');

    expect(glyphs(h)).toEqual({
      'Basics/01 Intro.webm': '✓',
      'Basics/02 Setup.webm': '✓',
      'Advanced/03 Closures.webm': '◐',
      'Advanced/04 Prototypes.webm': '○',
    });
    expect(descriptionOf(h, 'Basics/')).toBe('2/2');
    expect(h.ui.lessonTree?.summary?.description).toBe('2/4 · 50%');
  });

  it('is saved with the Course, so the marks are there when VS Code starts again', async () => {
    const h = await createHarness();
    const course = await openWithProgress(h);
    await h.core.markSectionDone('Basics/');

    await reopen(h, course);

    expect(glyphs(h)['Basics/01 Intro.webm']).toBe('✓');
    expect(glyphs(h)['Basics/02 Setup.webm']).toBe('✓');
    expect(glyphs(h)['Advanced/03 Closures.webm']).toBe('◐');
  });

  it('keeps where a Lesson in progress was left, and starts a Lesson never played at 0:00', async () => {
    const h = await createHarness();
    const course = await openWithProgress(h);
    await h.core.markSectionDone('Basics/');
    await reopen(h, course);

    h.core.playLesson('Basics/01 Intro.webm');
    expect(h.player.sent.at(-1)).toMatchObject({ lessonId: 'Basics/01 Intro.webm', startAt: 295 });
    h.core.playLesson('Basics/02 Setup.webm');
    expect(h.player.sent.at(-1)).toMatchObject({ lessonId: 'Basics/02 Setup.webm', startAt: 0 });
  });

  it('marks the Lessons of the Sections inside the Section too', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      'Part 1/01 Intro.webm': 'video',
      'Part 1/Exercises/02 Warm-up.webm': 'video',
      'Part 1/Exercises/03 Drill.webm': 'video',
      'Part 2/04 Wrap-up.webm': 'video',
    });
    await h.core.openCourse(course);
    h.player.ready();

    await h.core.markSectionDone('Part 1/');

    expect(glyphs(h)).toEqual({
      'Part 1/01 Intro.webm': '✓',
      'Part 1/Exercises/02 Warm-up.webm': '✓',
      'Part 1/Exercises/03 Drill.webm': '✓',
      'Part 2/04 Wrap-up.webm': '○',
    });
    expect(descriptionOf(h, 'Part 1/Exercises/')).toBe('2/2');
  });
});
