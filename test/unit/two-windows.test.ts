import { createHash } from 'node:crypto';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness, type FakePlayer, type Harness, type OtherWindow } from './harness.js';

const intro = 'Basics/01 Intro.webm';
const setup = 'Basics/02 Setup.webm';
const closures = 'Advanced/03 Closures.webm';

/** The player plays the Lesson and reports the playhead at `position` (of a 600 s Lesson). */
function playTo(player: FakePlayer, lessonId: string, position: number): void {
  player.emit({ type: 'played', lessonId });
  player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
}

/** The learner pauses: Progress is saved right away. */
function pause(player: FakePlayer, lessonId: string): void {
  player.emit({ type: 'paused', lessonId, byUser: true });
}

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

/** Time passes on both windows' clocks. */
function wait(h: Harness, other: OtherWindow, ms: number): void {
  h.clock.advance(ms);
  other.clock.advance(ms);
}

/** A Course open in two VS Code windows: the harness's window and `other`. */
async function openInTwoWindows(
  clockOffsetMs = 500,
): Promise<{ h: Harness; other: OtherWindow; course: string }> {
  const h = await createHarness();
  const course = await h.folder('course', {
    [intro]: 'video',
    [setup]: 'video',
    [closures]: 'video',
  });
  const other = h.openWindow({ clockOffsetMs });
  await h.core.openCourse(course);
  h.player.ready();
  await other.core.openCourse(course);
  other.player.ready();
  return { h, other, course };
}

/**
 * Where each Lesson starts when the learner plays it after VS Code starts again. `other`, the
 * second window, is closed first: it saves what it has, as a window closing does.
 */
async function startsAfterRestart(
  h: Harness,
  course: string,
  lessonIds: readonly string[],
  other?: OtherWindow,
): Promise<Record<string, unknown>> {
  await other?.core.close();
  await h.settle();
  h.restart();
  h.clock.advance(60_000);
  await h.core.openCourse(course);
  h.player.ready();
  const starts: Record<string, unknown> = {};
  for (const lessonId of lessonIds) {
    h.core.playLesson(lessonId);
    const load = h.player.sent.findLast((command) => command.type === 'load');
    starts[lessonId] = load?.type === 'load' ? load.startAt : undefined;
  }
  return starts;
}

describe('two windows on the same Course', () => {
  it('keeps the Progress of the Lesson each window played, whichever saved last', async () => {
    const { h, other, course } = await openInTwoWindows();

    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    pause(h.player, intro);
    await h.settle();
    other.core.playLesson(setup);
    playTo(other.player, setup, 200);
    pause(other.player, setup);
    await h.settle();
    h.clock.advance(1_000);
    playTo(h.player, intro, 150);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro, setup], other)).toEqual({
      [intro]: 145,
      [setup]: 195,
    });
  });

  it('keeps the newer save of the same Lesson, also when the older one is written after it', async () => {
    // The other window's clock is 10 s ahead (a Course on a share, written from two machines).
    const { h, other, course } = await openInTwoWindows(10_000);

    other.core.playLesson(intro);
    playTo(other.player, intro, 300);
    pause(other.player, intro);
    await h.settle();
    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 295 });
  });

  it('keeps the save written later when it is also the newer one', async () => {
    const { h, other, course } = await openInTwoWindows();

    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    pause(h.player, intro);
    await h.settle();
    other.clock.advance(1_000);
    other.core.playLesson(intro);
    playTo(other.player, intro, 300);
    pause(other.player, intro);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 295 });
  });

  it('keeps a done mark from one window when the other, still playing the Lesson, saves its place', async () => {
    const { h, other, course } = await openInTwoWindows(0);
    other.core.playLesson(intro);
    playTo(other.player, intro, 100);
    pause(other.player, intro);
    await h.settle();
    wait(h, other, 1_000);

    await h.core.markLessonDone(intro);
    wait(h, other, 1_000);
    playTo(other.player, intro, 120);
    pause(other.player, intro);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 115 });
    expect(glyphs(h)[intro]).toBe('✓');
  });

  it('keeps a done mark when the other window then plays the Lesson past its 10 s', async () => {
    const { h, other, course } = await openInTwoWindows(0);
    other.core.playLesson(intro);
    other.player.emit({ type: 'played', lessonId: intro });
    for (let position = 0; position <= 4; position += 2) {
      other.player.emit({ type: 'timeUpdate', lessonId: intro, position, duration: 600 });
    }
    wait(h, other, 1_000);

    await h.core.markLessonDone(intro);
    wait(h, other, 1_000);
    // The other window has not seen the mark; its play now counts as in progress.
    for (let position = 6; position <= 20; position += 2) {
      other.player.emit({ type: 'timeUpdate', lessonId: intro, position, duration: 600 });
    }
    pause(other.player, intro);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 15 });
    expect(glyphs(h)[intro]).toBe('✓');
  });

  it('keeps a reset and the play after it over a done mark the other window still had', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [intro]: 'video', [setup]: 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    await h.core.markLessonDone(intro);
    await h.settle();
    const other = h.openWindow({ clockOffsetMs: 0 });
    await other.core.openCourse(course);
    other.player.ready();
    wait(h, other, 1_000);

    await h.core.markLessonNotDone(intro);
    wait(h, other, 1_000);
    // This window plays the Lesson again, past its 10 s: it is in progress again.
    h.player.emit({ type: 'played', lessonId: intro });
    for (let position = 0; position <= 20; position += 2) {
      h.player.emit({ type: 'timeUpdate', lessonId: intro, position, duration: 600 });
    }
    pause(h.player, intro);
    await h.settle();
    wait(h, other, 1_000);
    // The other window, which still has the Lesson done, saves another Lesson.
    other.core.playLesson(setup);
    playTo(other.player, setup, 50);
    pause(other.player, setup);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 15 });
    expect(glyphs(h)[intro]).toBe('◐');
  });

  it('keeps the place the other window saved when a Lesson is marked done', async () => {
    const { h, other, course } = await openInTwoWindows(0);
    other.core.playLesson(intro);
    playTo(other.player, intro, 100);
    pause(other.player, intro);
    await h.settle();
    wait(h, other, 1_000);

    await h.core.markLessonDone(intro);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 95 });
    expect(glyphs(h)[intro]).toBe('✓');
  });

  it('keeps a Lesson marked not done when the other window still had it done', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [intro]: 'video', [setup]: 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    await h.core.markLessonDone(intro);
    await h.settle();
    const other = h.openWindow({ clockOffsetMs: 0 });
    await other.core.openCourse(course);
    other.player.ready();
    other.core.playLesson(intro);
    wait(h, other, 1_000);

    await h.core.markLessonNotDone(intro);
    wait(h, other, 1_000);
    playTo(other.player, intro, 300);
    pause(other.player, intro);

    // The other window's place is newer than the reset, so it counts again; its done mark does not.
    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 295 });
    expect(glyphs(h)[intro]).not.toBe('✓');
  });

  it('resets a Lesson over an older place the other window writes after the reset', async () => {
    // The other window's clock is 5 s behind (another machine on a share): its save is older.
    const { h, other, course } = await openInTwoWindows(-5_000);
    other.core.playLesson(intro);
    playTo(other.player, intro, 200);
    wait(h, other, 1_000);

    await h.core.markLessonNotDone(intro);
    wait(h, other, 1_000);
    pause(other.player, intro);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 0 });
    expect(glyphs(h)[intro]).toBe('○');
  });

  it('keeps a place the other window saves after a reset: it is Progress again', async () => {
    const { h, other, course } = await openInTwoWindows(0);
    other.core.playLesson(intro);
    playTo(other.player, intro, 200);
    pause(other.player, intro);
    await h.settle();
    wait(h, other, 1_000);

    await h.core.markLessonNotDone(intro);
    wait(h, other, 1_000);
    playTo(other.player, intro, 250);
    pause(other.player, intro);

    expect(await startsAfterRestart(h, course, [intro], other)).toEqual({ [intro]: 245 });
  });

  it('keeps both Lessons when the two windows save at the same moment', async () => {
    const { h, other, course } = await openInTwoWindows(0);
    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    other.core.playLesson(setup);
    playTo(other.player, setup, 200);

    pause(h.player, intro);
    pause(other.player, setup);

    expect(await startsAfterRestart(h, course, [intro, setup], other)).toEqual({
      [intro]: 95,
      [setup]: 195,
    });
    // The windows took turns, and gave the turn back: no lock is left in the Course.
    expect(await h.listFiles(join(course, '.followalong'))).toEqual(['progress.json']);
  });

  it('keeps both Lessons when one window saves while the other is between its read and its write', async () => {
    const { h, other, course } = await openInTwoWindows(0);
    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    other.core.playLesson(setup);
    playTo(other.player, setup, 200);
    const write = h.holdFirstFileWrite(join(course, '.followalong', 'progress.json'));

    pause(h.player, intro);
    // This window has read the file and merged it, and is about to replace it.
    await write.reached;
    pause(other.player, setup);
    // The other window's save runs meanwhile (or waits for its turn, about 0.3 s here).
    await new Promise((resolve) => setTimeout(resolve, 300));
    write.release();

    expect(await startsAfterRestart(h, course, [intro, setup], other)).toEqual({
      [intro]: 95,
      [setup]: 195,
    });
  });

  it('resets the Lessons the other window saved, when the Course is reset', async () => {
    const { h, other, course } = await openInTwoWindows(0);
    other.core.playLesson(setup);
    playTo(other.player, setup, 200);
    pause(other.player, setup);
    await h.settle();
    wait(h, other, 1_000);

    const resetting = h.core.resetCourseProgress();
    await h.settle();
    h.ui.answerQuestion('accept');
    await resetting;

    expect(await startsAfterRestart(h, course, [setup], other)).toEqual({ [setup]: 0 });
    expect(glyphs(h)[setup]).toBe('○');
    // The Course reopened on its first Lesson (Advanced/ comes first), not on the one the other
    // window played last.
    expect(h.player.sent.find((command) => command.type === 'load')).toMatchObject({
      lessonId: closures,
      startAt: 0,
    });
  });
});

describe('one window, with the file read again before each write', () => {
  it('keeps the place a Lesson plays on to right after it was reset', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [intro]: 'video', [setup]: 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson(intro);
    playTo(h.player, intro, 300);
    pause(h.player, intro);
    await h.settle();

    // Within the same millisecond: the reset is stamped after the save it replaces.
    await h.core.markLessonNotDone(intro);
    playTo(h.player, intro, 310);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro])).toEqual({ [intro]: 305 });
  });
});

describe('the lock two windows take turns with', () => {
  /** A Course whose `.followalong` holds a lock on `progress.json` last touched `ageMs` ago. */
  async function courseWithLock(
    ageMs: number,
  ): Promise<{ h: Harness; course: string; lock: string }> {
    const h = await createHarness();
    const course = await h.folder('course', {
      [intro]: 'video',
      '.followalong/progress.json.lock': '4242',
    });
    const lock = join(course, '.followalong', 'progress.json.lock');
    const touched = new Date(Date.now() - ageMs);
    await utimes(lock, touched, touched);
    await h.core.openCourse(course);
    h.player.ready();
    return { h, course, lock };
  }

  it('takes over a lock left behind by a window that stopped, and saves', async () => {
    const { h, course } = await courseWithLock(60 * 60_000);

    playTo(h.player, intro, 100);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro])).toEqual({ [intro]: 95 });
    expect(await h.listFiles(join(course, '.followalong'))).toEqual(['progress.json']);
  });

  it('saves after a moment when another window keeps the lock, and leaves that lock alone', async () => {
    const { h, course } = await courseWithLock(0);

    playTo(h.player, intro, 100);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro])).toEqual({ [intro]: 95 });
    expect(await h.listFiles(join(course, '.followalong'))).toEqual([
      'progress.json',
      'progress.json.lock',
    ]);
    expect(h.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('without its lock') as unknown,
      }),
    );
  });
});

describe('Course data another window changes while this one has the Course open', () => {
  it('never writes over a progress file a newer FollowAlong wrote meanwhile, and keeps Progress elsewhere', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [intro]: 'video', [setup]: 'video' });
    const progressFile = join(course, '.followalong', 'progress.json');
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h.player, intro, 100);
    pause(h.player, intro);
    await h.settle();
    // A window running a newer FollowAlong rewrites the file in a version this one can't read.
    const newer = `${JSON.stringify({ version: 99, data: { lessons: {} } })}\n`;
    await writeFile(progressFile, newer);

    playTo(h.player, intro, 150);
    pause(h.player, intro);
    await h.settle();
    playTo(h.player, intro, 200);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro])).toEqual({ [intro]: 195 });
    expect(await readFile(progressFile, 'utf8')).toBe(newer);
    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: "FollowAlong can't update this Course's progress file: it is damaged, unreadable or from a newer FollowAlong, so FollowAlong keeps your progress in its own storage for now.",
      },
    ]);
  });

  it('saves into .followalong again after a read before a save failed for a moment', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [intro]: 'video' });
    const progressFile = join(course, '.followalong', 'progress.json');
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h.player, intro, 100);
    pause(h.player, intro);
    await h.settle();

    // An antivirus scan holds the file while the next save reads it, then lets it go.
    h.makeUnreadable(progressFile);
    playTo(h.player, intro, 150);
    pause(h.player, intro);
    await h.settle();
    h.makeReadable(progressFile);
    playTo(h.player, intro, 200);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro])).toEqual({ [intro]: 195 });
    expect(await h.listFiles(h.storage.folder).catch(() => [])).toEqual([]);
    expect(h.ui.messages.filter((message) => message.text.includes('damaged'))).toEqual([]);
  });

  it('lets a reset written before statusAt existed win over an older done mark in the other copy', async () => {
    const h = await createHarness();
    const progress = (lessons: Record<string, unknown>): string =>
      `${JSON.stringify({ version: 1, data: { lessons } })}\n`;
    // A reset as FollowAlong wrote it before #27 (ADR 0061), in the Course's copy…
    const course = await h.folder('course', {
      [intro]: 'video',
      '.followalong/progress.json': progress({
        [intro]: { position: 0, duration: 0, savedAt: 200 },
      }),
    });
    // …and an older done mark in the fallback copy (ADR 0005: keyed by the Course's path).
    const hash = createHash('sha256').update(course).digest('hex').slice(0, 16);
    const fallback = join(h.storage.folder, 'courses', `course-${hash}`);
    await mkdir(fallback, { recursive: true });
    await writeFile(
      join(fallback, 'progress.json'),
      progress({ [intro]: { position: 300, duration: 600, savedAt: 100, status: 'done' } }),
    );

    await h.core.openCourse(course);

    expect(glyphs(h)[intro]).toBe('○');
    h.player.ready();
    h.core.playLesson(intro);
    expect(h.player.sent.at(-1)).toMatchObject({ lessonId: intro, startAt: 0 });
  });

  it('keeps the Resources both windows attach at the same moment', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      [intro]: 'video',
      [setup]: 'video',
      'notes.md': '# notes',
      'cheat.md': '# cheat',
    });
    const other = h.openWindow({ clockOffsetMs: 0 });
    await h.core.openCourse(course);
    await other.core.openCourse(course);

    await Promise.all([
      h.core.attachResource(intro, join(course, 'notes.md')),
      other.core.attachResource(setup, join(course, 'cheat.md')),
    ]);

    const stored = JSON.parse(
      await readFile(join(course, '.followalong', 'resources.json'), 'utf8'),
    ) as { readonly data: unknown };
    expect(stored.data).toMatchObject({
      lessons: { [intro]: [{ path: 'notes.md' }], [setup]: [{ path: 'cheat.md' }] },
    });
    expect(await h.listFiles(join(course, '.followalong'))).toEqual(['resources.json']);
  });
});
