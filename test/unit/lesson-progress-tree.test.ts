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

/** The player plays the Lesson from 0:00 up to `until` seconds, reporting every 2 s (600 s long unless said). */
function playUntil(h: Harness, lessonId: string, until: number, duration = 600): void {
  h.player.emit({ type: 'played', lessonId });
  for (let position = 0; position <= until; position += 2) {
    h.player.emit({ type: 'timeUpdate', lessonId, position, duration });
  }
}

/** The text shown beside the Lesson or Section with this id, if any. */
function descriptionOf(h: Harness, id: string): string | undefined {
  for (const node of allNodes(h)) {
    if (node.kind !== 'resource' && node.id === id) {
      return node.description;
    }
  }
  return undefined;
}

/** The state of the Lesson with this id. */
function statusOf(h: Harness, lessonId: string): string | undefined {
  for (const node of allNodes(h)) {
    if (node.kind === 'lesson' && node.id === lessonId) {
      return node.status;
    }
  }
  return undefined;
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

  it('refreshes the tree as a Lesson becomes in progress and then done, while it plays', async () => {
    const h = await createHarness();
    const course = await h.folder('course', threeLessons);
    await h.core.openCourse(course);
    h.player.ready();
    const lesson = '01 Intro.webm';

    playUntil(h, lesson, 6);
    expect(glyphs(h)[lesson]).toBe('○');

    playUntil(h, lesson, 12);
    expect(glyphs(h)[lesson]).toBe('◐');

    h.player.emit({ type: 'timeUpdate', lessonId: lesson, position: 570, duration: 600 });
    expect(glyphs(h)[lesson]).toBe('✓');
  });

  it('shows position / length beside a Lesson in progress, and nothing beside the others', async () => {
    const h = await createHarness();
    const course = await h.folder('course', threeLessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('01 Intro.webm');
    playUntil(h, '01 Intro.webm', 750, 2405);
    pause(h, '01 Intro.webm');
    h.core.playLesson('02 Setup.webm');
    playUntil(h, '02 Setup.webm', 590);
    pause(h, '02 Setup.webm');

    await reopen(h, course);

    expect(descriptionOf(h, '01 Intro.webm')).toBe('12:30 / 40:05');
    expect(descriptionOf(h, '02 Setup.webm')).toBe('');
    expect(descriptionOf(h, '03 Closures.webm')).toBe('');
    expect(statusOf(h, '01 Intro.webm')).toBe('inProgress');
  });

  it('shows done/total beside each Section, counting the Sections inside it', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      'A/01 a.webm': 'video',
      'A/02 b.webm': 'video',
      'A/Deep/03 c.webm': 'video',
      'B/04 d.webm': 'video',
    });
    await h.core.openCourse(course);
    h.player.ready();

    h.core.playLesson('A/01 a.webm');
    playUntil(h, 'A/01 a.webm', 580);
    h.core.playLesson('A/Deep/03 c.webm');
    playUntil(h, 'A/Deep/03 c.webm', 580);

    expect(descriptionOf(h, 'A/')).toBe('2/3');
    expect(descriptionOf(h, 'A/Deep/')).toBe('1/1');
    expect(descriptionOf(h, 'B/')).toBe('0/1');
  });

  it('shows done/total and the percent for the whole Course, rounded down so 100% means all done', async () => {
    const h = await createHarness();
    const course = await h.folder('course', threeLessons);
    await h.core.openCourse(course);
    h.player.ready();
    expect(h.ui.lessonTree?.summary).toEqual({
      done: 0,
      total: 3,
      percent: 0,
      description: '0/3 · 0%',
    });

    h.core.playLesson('01 Intro.webm');
    playUntil(h, '01 Intro.webm', 580);
    expect(h.ui.lessonTree?.summary?.description).toBe('1/3 · 33%');

    h.core.playLesson('02 Setup.webm');
    playUntil(h, '02 Setup.webm', 580);
    expect(h.ui.lessonTree?.summary?.description).toBe('2/3 · 66%');

    h.core.playLesson('03 Closures.webm');
    playUntil(h, '03 Closures.webm', 580);
    expect(h.ui.lessonTree?.summary).toEqual({
      done: 3,
      total: 3,
      percent: 100,
      description: '3/3 · 100%',
    });
  });

  it('redraws the tree only when a Lesson changes state or Progress is saved, never on every timeUpdate', async () => {
    const h = await createHarness();
    const course = await h.folder('course', threeLessons);
    await h.core.openCourse(course);
    h.player.ready();
    const lesson = '01 Intro.webm';
    const before = h.ui.lessonTreeDraws;
    h.player.emit({ type: 'played', lessonId: lesson });

    // A minute of play, reported every 250 ms: 240 timeUpdates and 12 saves.
    for (let tick = 0; tick <= 240; tick += 1) {
      h.clock.advance(250);
      h.player.emit({ type: 'timeUpdate', lessonId: lesson, position: tick / 4, duration: 2405 });
    }

    // One redraw for ○ → ◐ at 10 s, then at most one per 5 s save.
    expect(h.ui.lessonTreeDraws - before).toBeLessThanOrEqual(1 + 12);
    // The last save, at 60 s, saw the playhead at 59.75 s.
    expect(descriptionOf(h, lesson)).toBe('00:59 / 40:05');
  });

  it('updates the in-progress text at the save interval, not in between', async () => {
    const h = await createHarness();
    const course = await h.folder('course', threeLessons);
    await h.core.openCourse(course);
    h.player.ready();
    const lesson = '01 Intro.webm';
    h.player.emit({ type: 'played', lessonId: lesson });
    for (let position = 0; position <= 12; position += 2) {
      h.player.emit({ type: 'timeUpdate', lessonId: lesson, position, duration: 2405 });
    }
    const shownAt12 = descriptionOf(h, lesson);

    h.player.emit({ type: 'timeUpdate', lessonId: lesson, position: 14, duration: 2405 });
    expect(descriptionOf(h, lesson)).toBe(shownAt12);

    h.clock.advance(5000);
    expect(descriptionOf(h, lesson)).toBe('00:14 / 40:05');
  });

  it('shows where the Lesson was left when the learner moves on to another Lesson', async () => {
    const h = await createHarness();
    const course = await h.folder('course', threeLessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('01 Intro.webm');
    playUntil(h, '01 Intro.webm', 750, 2405);

    h.core.playLesson('02 Setup.webm');

    expect(descriptionOf(h, '01 Intro.webm')).toBe('12:30 / 40:05');
  });
});
