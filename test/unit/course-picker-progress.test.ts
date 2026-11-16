import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';

/** The `detail` line of the picker's item, as the learner reads it under the Course's name. */
function detailOf(picker: QuickPickModel<unknown> | undefined, label: string): string | undefined {
  const entry = picker?.entries.find(
    (candidate) => candidate.kind === 'item' && candidate.label === label,
  );
  return entry?.kind === 'item' ? entry.detail : undefined;
}

function saved(position: number, status?: 'done' | 'inProgress') {
  return { position, duration: 600, savedAt: 1000, ...(status === undefined ? {} : { status }) };
}

/** The text of a version 1 `progress.json`. */
function progressFile(
  lessons: Record<string, ReturnType<typeof saved>>,
  last?: { lessonId: string; savedAt: number },
): string {
  return JSON.stringify({ version: 1, data: { lessons, ...(last === undefined ? {} : { last }) } });
}

async function openPicker(h: Harness, learning: string): Promise<void> {
  h.config.set('coursesRoots', [learning]);
  void h.core.pickCourse();
  await h.ui.pickerShown();
}

describe('the Progress line in the Course picker', () => {
  it('shows done/total, percent and the last Lesson title for a Course with Progress', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Algebra/01 Intro.mp4': 'v',
      'Algebra/02 Limits.mp4': 'v',
      'Algebra/03 Series.mp4': 'v',
      'Algebra/.followalong/progress.json': progressFile(
        { '01 Intro.mp4': saved(600, 'done'), '02 Limits.mp4': saved(30, 'inProgress') },
        { lessonId: '02 Limits.mp4', savedAt: 2000 },
      ),
    });

    await openPicker(h, learning);

    expect(detailOf(h.ui.picker, 'Algebra')).toBe('1/3 · 33% · last: Limits');
  });

  it('shows no Progress line for a Course nobody played, or whose Progress was reset', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Fresh/intro.mp4': 'v',
      'Reset/intro.mp4': 'v',
      'Reset/.followalong/progress.json': progressFile(
        { 'intro.mp4': saved(0) },
        { lessonId: '', savedAt: 5000 },
      ),
    });

    await openPicker(h, learning);

    expect(detailOf(h.ui.picker, 'Fresh')).toBeUndefined();
    expect(detailOf(h.ui.picker, 'Reset')).toBeUndefined();
  });

  it('leaves out “last:” when the last Lesson is unknown or was reset', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Gone/a.mp4': 'v',
      'Gone/.followalong/progress.json': progressFile(
        { 'a.mp4': saved(600, 'done') },
        { lessonId: 'deleted.mp4', savedAt: 2000 },
      ),
      'Cleared/a.mp4': 'v',
      'Cleared/.followalong/progress.json': progressFile(
        { 'a.mp4': saved(600, 'done') },
        { lessonId: '', savedAt: 2000 },
      ),
    });

    await openPicker(h, learning);

    expect(detailOf(h.ui.picker, 'Gone')).toBe('1/1 · 100%');
    expect(detailOf(h.ui.picker, 'Cleared')).toBe('1/1 · 100%');
  });

  it('rounds the percent down, as the tree does: 100% only when every Lesson is done', async () => {
    const h = await createHarness();
    const lessons = Object.fromEntries(
      Array.from({ length: 140 }, (_, i) => [`${String(i).padStart(3, '0')}.mp4`, 'v']),
    );
    const done = Object.fromEntries(
      Array.from({ length: 27 }, (_, i) => [
        `${String(i).padStart(3, '0')}.mp4`,
        saved(600, 'done'),
      ]),
    );
    const learning = await h.folder('Learning', {
      ...Object.fromEntries(Object.entries(lessons).map(([k, v]) => [`Big/${k}`, v])),
      'Big/.followalong/progress.json': progressFile(done, { lessonId: '026.mp4', savedAt: 2000 }),
    });

    await openPicker(h, learning);

    expect(detailOf(h.ui.picker, 'Big')).toBe('27/140 · 19% · last: 026');
  });

  it('reads the newest copy per Lesson from .followalong and the fallback storage', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Split/a.mp4': 'v',
      'Split/b.mp4': 'v',
      'Split/.followalong/progress.json': progressFile(
        { 'a.mp4': { ...saved(0), savedAt: 1000 } },
        { lessonId: 'a.mp4', savedAt: 1000 },
      ),
    });
    const course = join(learning, 'Split');
    const hash = createHash('sha256').update(course).digest('hex').slice(0, 16);
    const fallback = join(h.storage.folder, 'courses', `Split-${hash}`);
    await mkdir(fallback, { recursive: true });
    await writeFile(
      join(fallback, 'progress.json'),
      progressFile(
        {
          'a.mp4': { ...saved(600, 'done'), savedAt: 3000 },
          'b.mp4': { ...saved(5, 'inProgress'), savedAt: 3000 },
        },
        { lessonId: 'b.mp4', savedAt: 3000 },
      ),
    );

    await openPicker(h, learning);

    expect(detailOf(h.ui.picker, 'Split')).toBe('1/2 · 50% · last: b');
  });

  it('shows no line for a Progress file it cannot read, and never touches it', async () => {
    const h = await createHarness();
    const damaged = '{ not json';
    const learning = await h.folder('Learning', {
      'Broken/a.mp4': 'v',
      'Broken/.followalong/progress.json': damaged,
      'Newer/a.mp4': 'v',
      'Newer/.followalong/progress.json': JSON.stringify({ version: 99, data: {} }),
    });

    await openPicker(h, learning);

    expect(detailOf(h.ui.picker, 'Broken')).toBeUndefined();
    expect(detailOf(h.ui.picker, 'Newer')).toBeUndefined();
    expect(await readFile(join(learning, 'Broken', '.followalong', 'progress.json'), 'utf8')).toBe(
      damaged,
    );
    expect(await h.listFiles(learning)).toEqual([
      'Broken/.followalong/progress.json',
      'Broken/a.mp4',
      'Newer/.followalong/progress.json',
      'Newer/a.mp4',
    ]);
    expect(await h.listFiles(h.storage.folder).catch(() => [])).toEqual([]);
  });

  it('opens at once, and fills the Progress lines in when they are read', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Slow/a.mp4': 'v',
      'Slow/.followalong/progress.json': progressFile({ 'a.mp4': saved(600, 'done') }),
    });
    h.config.set('coursesRoots', [learning]);
    const hold = h.holdFileReads(join(learning, 'Slow', '.followalong', 'progress.json'));

    void h.core.pickCourse();
    await h.ui.pickerOpened();
    await hold.reached;

    expect(detailOf(h.ui.picker, 'Slow')).toBeUndefined();
    expect(h.ui.pickerBusy).toBe(true);

    hold.release();
    await h.ui.pickerShown();

    expect(detailOf(h.ui.picker, 'Slow')).toBe('1/1 · 100%');
    expect(h.ui.pickerBusy).toBe(false);
  });

  it('lets the learner pick a Course while its Progress line is still being read', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Slow/a.mp4': 'v',
      'Slow/.followalong/progress.json': progressFile({ 'a.mp4': saved(600, 'done') }),
    });
    // A first look fills the Course list cache, so the next picker lists `Slow` at once.
    await openPicker(h, learning);
    h.ui.dismissPicker();
    const hold = h.holdFileReads(join(learning, 'Slow', '.followalong', 'progress.json'));

    const picking = h.core.pickCourse();
    await h.ui.pickerOpened();
    await hold.reached;
    h.ui.choose('Slow');
    hold.release();
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      { type: 'load', videoUri: h.player.resourceUri(join(learning, 'Slow', 'a.mp4')) },
    ]);
  });

  it('shows the Progress line on a Recent Course too', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Seen/a.mp4': 'v',
      'Seen/b.mp4': 'v',
      'Seen/.followalong/progress.json': progressFile(
        { 'a.mp4': saved(600, 'done') },
        { lessonId: 'a.mp4', savedAt: 2000 },
      ),
    });
    h.config.set('coursesRoots', [learning]);
    const opening = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Seen');
    await opening;

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(h.ui.picker?.entries[0]).toMatchObject({ kind: 'separator', label: 'Recent Courses' });
    expect(detailOf(h.ui.picker, 'Seen')).toBe('1/2 · 50% · last: a');
  });
});
