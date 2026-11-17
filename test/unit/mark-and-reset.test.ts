import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';
import { makeReadOnly } from './read-only.js';

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

describe('Reset Section', () => {
  it('resets the done marks and positions of the Section, and nothing outside it', async () => {
    const h = await createHarness();
    const course = await openWithProgress(h);
    await h.core.markSectionDone('Basics/');

    await h.core.resetSection('Basics/');

    expect(glyphs(h)).toEqual({
      'Basics/01 Intro.webm': '○',
      'Basics/02 Setup.webm': '○',
      'Advanced/03 Closures.webm': '◐',
      'Advanced/04 Prototypes.webm': '○',
    });
    expect(descriptionOf(h, 'Basics/')).toBe('0/2');
    expect(descriptionOf(h, 'Advanced/03 Closures.webm')).toBe('00:12 / 10:00');

    await reopen(h, course);
    h.core.playLesson('Basics/01 Intro.webm');
    expect(h.player.sent.at(-1)).toMatchObject({ lessonId: 'Basics/01 Intro.webm', startAt: 0 });
    h.core.playLesson('Advanced/03 Closures.webm');
    expect(h.player.sent.at(-1)).toMatchObject({
      lessonId: 'Advanced/03 Closures.webm',
      startAt: 7,
    });
  });

  it('leaves the Lesson the Course reopens on as it is, even inside the Section', async () => {
    const h = await createHarness();
    const course = await openWithProgress(h);

    // The Lesson played last, 'Advanced/03', is in the Section that is reset.
    await h.core.resetSection('Advanced/');

    expect(await reopen(h, course)).toMatchObject({
      lessonId: 'Advanced/03 Closures.webm',
      startAt: 0,
    });
  });

  it('starts the Lesson that is playing again: its 10 s of play count from the reset', async () => {
    const h = await createHarness();
    const course = await h.folder('course', twoSections);
    await h.core.openCourse(course);
    h.player.ready();
    const lesson = 'Basics/01 Intro.webm';
    h.core.playLesson(lesson);
    playUntil(h, lesson, 12);
    expect(glyphs(h)[lesson]).toBe('◐');

    await h.core.resetSection('Basics/');
    h.player.emit({ type: 'timeUpdate', lessonId: lesson, position: 14, duration: 600 });

    expect(glyphs(h)[lesson]).toBe('○');
    for (let position = 16; position <= 26; position += 2) {
      h.player.emit({ type: 'timeUpdate', lessonId: lesson, position, duration: 600 });
    }
    expect(glyphs(h)[lesson]).toBe('◐');
  });
});

describe('Reset Course progress', () => {
  it('asks first, and resets the whole Course only once the learner agrees', async () => {
    const h = await createHarness();
    const course = await openWithProgress(h);
    await h.core.markSectionDone('Basics/');
    // The Lesson played last is not the Course's first.
    h.core.playLesson('Basics/02 Setup.webm');
    playUntil(h, 'Basics/02 Setup.webm', 30);
    pause(h, 'Basics/02 Setup.webm');

    const resetting = h.core.resetCourseProgress();
    await h.settle();

    expect(h.ui.questions.filter((question) => question.text.includes('Reset'))).toHaveLength(1);
    expect(h.ui.questions.at(-1)?.text).toContain('“course”');
    expect(glyphs(h)['Basics/01 Intro.webm']).toBe('✓');

    h.ui.answerQuestion('accept');
    await resetting;

    expect(Object.values(glyphs(h))).toEqual(['○', '○', '○', '○']);
    expect(h.ui.lessonTree?.summary?.description).toBe('0/4 · 0%');

    // Reopening goes to the first Lesson from the start, as for a Course never played.
    expect(await reopen(h, course)).toMatchObject({
      lessonId: 'Advanced/03 Closures.webm',
      startAt: 0,
    });
    h.core.playLesson('Basics/02 Setup.webm');
    expect(h.player.sent.at(-1)).toMatchObject({ startAt: 0 });
  });

  it.each([
    ['declines', 'decline'],
    ['closes the question', undefined],
  ] as const)('changes nothing when the learner %s', async (_what, answer) => {
    const h = await createHarness();
    const course = await openWithProgress(h);
    await h.core.markSectionDone('Basics/');

    const resetting = h.core.resetCourseProgress();
    await h.settle();
    h.ui.answerQuestion(answer);
    await resetting;

    expect(glyphs(h)).toEqual({
      'Basics/01 Intro.webm': '✓',
      'Basics/02 Setup.webm': '✓',
      'Advanced/03 Closures.webm': '◐',
      'Advanced/04 Prototypes.webm': '○',
    });
    await reopen(h, course);
    expect(glyphs(h)['Basics/01 Intro.webm']).toBe('✓');
  });
});

describe('marking and resetting leave the rest of the Course data alone', () => {
  it('never touches the Resources or the prepared sound in .followalong, checked on disk', async () => {
    const h = await createHarness();
    const sound = '.followalong/sound/01 Intro-0123456789abcdef.mp3';
    const course = await h.folder('course', {
      ...twoSections,
      'cheat.md': '# cheat sheet',
      [sound]: 'sound of the first Lesson',
    });
    await h.core.openCourse(course);
    h.player.ready();
    await h.core.attachCourseResource(join(course, 'cheat.md'));
    await h.core.attachResource('Basics/01 Intro.webm', join(course, 'cheat.md'));
    const resources = await readFile(join(course, '.followalong', 'resources.json'), 'utf8');

    await h.core.markSectionDone('Basics/');
    await h.core.resetSection('Basics/');
    const resetting = h.core.resetCourseProgress();
    await h.settle();
    h.ui.answerQuestion('accept');
    await resetting;

    expect(await readFile(join(course, '.followalong', 'resources.json'), 'utf8')).toBe(resources);
    expect(await readFile(join(course, sound), 'utf8')).toBe('sound of the first Lesson');
    expect(await h.listFiles(join(course, '.followalong'))).toEqual([
      'progress.json',
      'resources.json',
      'sound/01 Intro-0123456789abcdef.mp3',
    ]);
    expect(h.ui.lessonTree?.course?.resources).toHaveLength(1);
  });

  it('wins over the older copy in .followalong when the Course turned read-only', async () => {
    const h = await createHarness();
    const course = await openWithProgress(h);
    await h.core.markSectionDone('Basics/');
    await h.settle();
    makeReadOnly(join(course, '.followalong'));

    // VS Code starts again within the same millisecond as the marks were saved.
    h.restart();
    await h.core.openCourse(course);
    h.player.ready();
    await h.core.resetSection('Basics/');

    // The reset went to the fallback storage; the next session reads both and the reset is newer.
    await reopen(h, course);
    expect(glyphs(h)['Basics/01 Intro.webm']).toBe('○');
    expect(glyphs(h)['Basics/02 Setup.webm']).toBe('○');
    expect(glyphs(h)['Advanced/03 Closures.webm']).toBe('◐');
  });

  it('resets the Lesson the Course reopens on too, over the older copy in .followalong', async () => {
    const h = await createHarness();
    const course = await openWithProgress(h);
    h.core.playLesson('Basics/02 Setup.webm');
    playUntil(h, 'Basics/02 Setup.webm', 30);
    pause(h, 'Basics/02 Setup.webm');
    await h.settle();
    makeReadOnly(join(course, '.followalong'));

    h.restart();
    await h.core.openCourse(course);
    h.player.ready();
    const resetting = h.core.resetCourseProgress();
    await h.settle();
    h.ui.answerQuestion('accept');
    await resetting;

    // The first Lesson, as for a Course never played, not the Lesson the older copy names.
    expect(await reopen(h, course)).toMatchObject({
      lessonId: 'Advanced/03 Closures.webm',
      startAt: 0,
    });
  });

  it('keeps a progress file it cannot read as it is, and saves the marks in the extension storage', async () => {
    const h = await createHarness();
    const damaged = '{"version": 1, "data": ';
    const course = await h.folder('course', {
      ...twoSections,
      '.followalong/progress.json': damaged,
    });
    await h.core.openCourse(course);
    h.player.ready();

    await h.core.markSectionDone('Basics/');

    expect(await readFile(join(course, '.followalong', 'progress.json'), 'utf8')).toBe(damaged);
    expect(await h.listFiles(h.storage.folder)).toEqual([
      expect.stringMatching(/^courses\/course-[0-9a-f]{16}\/progress\.json$/),
    ]);
    await reopen(h, course);
    expect(glyphs(h)['Basics/01 Intro.webm']).toBe('✓');
  });

  it('resets nothing when another Course was opened while the learner was asked', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'First/00 Intro.webm': 'video',
      'First/Part/01 One.webm': 'video',
      'First/Part/02 Two.webm': 'video',
      'Second/01 Intro.webm': 'video',
    });
    const first = join(learning, 'First');
    await h.core.openCourse(first);
    h.player.ready();
    await h.core.markSectionDone('Part/');
    const resetting = h.core.resetCourseProgress();
    await h.settle();
    await h.core.openCourse(join(learning, 'Second'));

    h.ui.answerQuestion('accept');
    await resetting;

    expect(h.ui.messages.at(-1)?.text).toContain('did not reset “First”');
    await reopen(h, first);
    expect(glyphs(h)['Part/01 One.webm']).toBe('✓');
    expect(glyphs(h)['Part/02 Two.webm']).toBe('✓');
  });

  it('says so when no Course is open', async () => {
    const h = await createHarness();

    await h.core.resetCourseProgress();
    await h.core.markSectionDone('Basics/');
    await h.core.resetSection('Basics/');

    expect(h.ui.questions).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'Open a Course first, then reset its Progress.' },
    ]);
  });

  it('ignores a Section the open Course does not have: nothing changes or is saved', async () => {
    const h = await createHarness();
    const course = await h.folder('course', twoSections);
    await h.core.openCourse(course);
    h.player.ready();
    const before = glyphs(h);

    await h.core.markSectionDone('Nowhere/');
    await h.core.resetSection('Nowhere/');

    expect(glyphs(h)).toEqual(before);
    expect(h.ui.messages).toEqual([]);
    expect(await h.listFiles(course)).toEqual(Object.keys(twoSections).sort());
  });
});
