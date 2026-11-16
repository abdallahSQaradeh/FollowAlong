import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';

const intro = 'Basics/01 Intro.webm';
const setup = 'Basics/02 Setup.webm';
const closures = 'Advanced/03 Closures.webm';

/** The Lesson nodes' glyphs by Lesson id, as the learner reads them in the tree. */
function glyphs(h: Harness): Record<string, string> {
  const walk = (nodes: readonly LessonTreeNode[]): [string, string][] =>
    nodes.flatMap((node) => {
      if (node.kind === 'section') {
        return walk(node.children);
      }
      return node.kind === 'lesson' ? [[node.id, node.glyph] as [string, string]] : [];
    });
  return Object.fromEntries(walk(h.ui.lessonTree?.nodes ?? []));
}

/** The player plays the Lesson from 0:00 up to `until` seconds, reporting every 2 s (600 s long). */
function playUntil(h: Harness, lessonId: string, until: number): void {
  h.player.emit({ type: 'played', lessonId });
  for (let position = 0; position <= until; position += 2) {
    h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
  }
}

/** A Course of two Sections with the first Lesson open and playing at 0:00. */
async function openFirstLesson(): Promise<{ h: Harness; course: string }> {
  const h = await createHarness();
  const course = await h.folder('course', {
    [intro]: 'video',
    [setup]: 'video',
    [closures]: 'video',
  });
  await h.core.openCourse(course);
  h.player.ready();
  h.core.playLesson(intro);
  h.player.emit({ type: 'played', lessonId: intro });
  return { h, course };
}

/** VS Code starts again within the minute and the learner opens the Course; returns the `load` the player gets. */
async function reopen(h: Harness, course: string) {
  await h.settle();
  h.restart();
  h.clock.advance(60_000);
  await h.core.openCourse(course);
  h.player.ready();
  return h.player.sent.at(-1);
}

describe('Mark done / not done with the chord key', () => {
  it('marks the Loaded Lesson done, and only that Lesson', async () => {
    const { h } = await openFirstLesson();

    await h.core.toggleLessonDone();

    expect(glyphs(h)).toEqual({ [intro]: '✓', [setup]: '○', [closures]: '○' });
  });

  it('marks it not done when pressed again, as if never played', async () => {
    const { h } = await openFirstLesson();
    playUntil(h, intro, 300);

    await h.core.toggleLessonDone();
    await h.core.toggleLessonDone();

    expect(glyphs(h)).toEqual({ [intro]: '○', [setup]: '○', [closures]: '○' });
  });

  it('starts a Lesson that was marked done and then not done at 0:00', async () => {
    const { h, course } = await openFirstLesson();
    playUntil(h, intro, 300);

    await h.core.toggleLessonDone();
    await h.core.toggleLessonDone();

    expect(await reopen(h, course)).toMatchObject({ lessonId: intro, startAt: 0 });
  });

  it('marks a Lesson that is in progress done, and it keeps its place', async () => {
    const { h, course } = await openFirstLesson();
    playUntil(h, intro, 300);
    expect(glyphs(h)[intro]).toBe('◐');

    await h.core.toggleLessonDone();
    expect(glyphs(h)[intro]).toBe('✓');

    expect(await reopen(h, course)).toMatchObject({ lessonId: intro, startAt: 295 });
  });

  it('clears the sticky done state: playing the start again does not bring it back', async () => {
    const { h } = await openFirstLesson();
    playUntil(h, intro, 598);
    expect(glyphs(h)[intro]).toBe('✓');

    await h.core.toggleLessonDone();
    expect(glyphs(h)[intro]).toBe('○');

    h.player.emit({ type: 'timeUpdate', lessonId: intro, position: 1, duration: 600 });
    expect(glyphs(h)[intro]).toBe('○');
  });

  it('keeps the mark after VS Code restarts, in both directions', async () => {
    const { h, course } = await openFirstLesson();

    await h.core.toggleLessonDone();
    await reopen(h, course);
    expect(glyphs(h)[intro]).toBe('✓');

    h.core.playLesson(intro);
    await h.core.toggleLessonDone();
    await reopen(h, course);
    expect(glyphs(h)[intro]).toBe('○');
  });

  it('tells the learner to open a Lesson first when no Course is open', async () => {
    const h = await createHarness();

    await h.core.toggleLessonDone();

    expect(h.ui.messages.map((message) => message.text)).toEqual([
      'Open a Lesson first, then mark it done.',
    ]);
  });
});

describe('Mark done / not done from the tree context menu', () => {
  it('marks any Lesson done, not only the one that is playing', async () => {
    const { h } = await openFirstLesson();

    await h.core.markLessonDone(closures);

    expect(glyphs(h)).toEqual({ [intro]: '○', [setup]: '○', [closures]: '✓' });
  });

  it('marks any Lesson not done, and the saved position goes', async () => {
    const { h, course } = await openFirstLesson();
    await h.core.markLessonDone(closures);
    await h.core.markLessonDone(setup);

    await h.core.markLessonNotDone(closures);
    expect(glyphs(h)).toEqual({ [intro]: '○', [setup]: '✓', [closures]: '○' });

    await reopen(h, course);
    expect(glyphs(h)).toEqual({ [intro]: '○', [setup]: '✓', [closures]: '○' });
  });

  it('logs and changes nothing for a Lesson the open Course does not have', async () => {
    const { h } = await openFirstLesson();

    await h.core.markLessonDone('Nowhere/99 Missing.webm');
    await h.core.markLessonNotDone('Nowhere/99 Missing.webm');

    expect(glyphs(h)).toEqual({ [intro]: '○', [setup]: '○', [closures]: '○' });
    expect(h.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
  });
});
