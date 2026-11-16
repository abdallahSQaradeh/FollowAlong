import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';

/** The picker as the learner reads it, top to bottom: a separator as `── label`, an item as its label. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator' ? `── ${entry.label}` : entry.label,
  );
}

/** The description of each item, in order: the category path and tags of a Course. */
function descriptions(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).flatMap((entry) =>
    entry.kind === 'item' && entry.description !== undefined ? [entry.description] : [],
  );
}

/** A Courses root with one Course, `Alpha`, opened once so the Course list cache holds it. */
async function libraryWithAlphaCached(h: Harness): Promise<string> {
  const learning = await h.folder('Learning', { 'Alpha/intro.mp4': 'v' });
  h.config.set('coursesRoots', [learning]);
  void h.core.pickCourse();
  await h.ui.pickerShown();
  h.ui.dismissPicker();
  return learning;
}

describe('the Course list cache', () => {
  it('opens the picker with the cached Courses before the rescan finishes, then updates it', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    await h.folder('Learning/Beta', { 'intro.mp4': 'v' });
    const finishScan = h.holdReads(learning);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Add Courses root…']);
    expect(h.ui.pickerBusy).toBe(true);

    finishScan();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
    expect(h.ui.pickerBusy).toBe(false);
  });

  it('opens from the cache again in a new window, with what the last rescan found', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    await h.folder('Learning/Beta', { 'intro.mp4': 'v' });
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    h.restart();
    const finishScan = h.holdReads(learning);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
    finishScan();
  });

  it('lets the learner pick a cached Course before the rescan is done', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    const finishScan = h.holdReads(learning);

    const picking = h.core.pickCourse();
    await h.ui.pickerOpened();
    h.ui.choose('Alpha');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([{ type: 'load' }]);
    finishScan();
  });

  it('has a Refresh button that rescans at once and shows a Course just downloaded', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    expect(h.ui.toolbarButtons).toEqual(['Refresh']);
    await h.folder('Learning/Beta', { 'intro.mp4': 'v' });
    const finishScan = h.holdReads(learning);

    h.ui.pressToolbar('Refresh');

    expect(h.ui.pickerBusy).toBe(true);
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Add Courses root…']);
    finishScan();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
  });

  it('keeps the new Course in the cache after Refresh', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    await h.folder('Learning/Beta', { 'intro.mp4': 'v' });
    h.ui.pressToolbar('Refresh');
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    h.restart();
    const finishScan = h.holdReads(learning);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
    finishScan();
  });

  it('drops a Course that is gone from the list when the rescan is done', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    await h.folder('Learning/Beta', { 'intro.mp4': 'v' });
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    await rm(join(learning, 'Beta'), { recursive: true });

    void h.core.pickCourse();
    await h.ui.pickerOpened();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Add Courses root…']);
  });

  it('saves the rescan in the cache even when the learner closed the picker before it ended', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    await h.folder('Learning/Beta', { 'intro.mp4': 'v' });
    const finishScan = h.holdReads(learning);
    const picking = h.core.pickCourse();
    await h.ui.pickerOpened();
    h.ui.dismissPicker();
    await picking;

    finishScan();
    await h.settle();
    h.restart();
    const holdAgain = h.holdReads(learning);
    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
    holdAgain();
  });

  it('opens with no Courses, busy, on the first run, and lists them when the scan is done', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Alpha/intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    const finishScan = h.holdReads(learning);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toEqual(['Add Courses root…']);
    expect(h.ui.pickerBusy).toBe(true);
    finishScan();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Add Courses root…']);
  });

  it('does not show the Courses of other roots from the cache', async () => {
    const h = await createHarness();
    await libraryWithAlphaCached(h);
    const other = await h.folder('Other', { 'Gamma/intro.mp4': 'v' });
    h.config.set('coursesRoots', [other]);
    const finishScan = h.holdReads(other);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toEqual(['Add Courses root…']);
    finishScan();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Gamma', 'Add Courses root…']);
  });

  it('brings nested Courses back from the cache with their category paths unchanged', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/Frontend/React Basics/wrapper/intro.mp4': 'v',
      'Web/Frontend/Vue/intro.mp4': 'v',
      'Plain/intro.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    const scanned = h.ui.picker;
    h.ui.dismissPicker();
    const finishScan = h.holdReads(learning);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(h.ui.pickerBusy).toBe(true);
    expect(rows(h.ui.picker)).toEqual(rows(scanned));
    expect(descriptions(h.ui.picker)).toEqual(descriptions(scanned));
    expect(descriptions(h.ui.picker)).toContain('Web / Frontend');
    finishScan();
  });

  it('ignores a cache it cannot read and scans as on the first run', async () => {
    const h = await createHarness();
    const learning = await libraryWithAlphaCached(h);
    await h.storage.global.set('courseListCache', { version: 99, courses: 'nonsense' });
    const finishScan = h.holdReads(learning);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toEqual(['Add Courses root…']);
    finishScan();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Add Courses root…']);
  });

  it('still shows the rescan when the cache cannot be written, and says so in the log', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Alpha/intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    h.failNextWrite('global', 'disk full');

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Add Courses root…']);
    expect(
      h.logger.entries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('disk full'),
      ),
    ).toBe(true);
  });

  it('opens at once with a Recent Course whose folder is slow to read, and marks it missing later', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Alpha/intro.mp4': 'v' });
    const moved = await h.folder('Moved', { 'intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(moved);
    await rm(moved, { recursive: true });
    h.restart();
    const finishRead = h.holdReads(moved);

    void h.core.pickCourse();
    await h.ui.pickerOpened();

    expect(rows(h.ui.picker)).toContain('Moved');
    expect(descriptions(h.ui.picker)).not.toContain('missing');
    finishRead();
    await h.ui.pickerShown();
    expect(descriptions(h.ui.picker)).toContain('missing');
  });

  it('stops being busy and logs the error when a Recent Course cannot be checked', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Alpha/intro.mp4': 'v' });
    const odd = await h.folder('Odd', { 'intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(odd);
    h.restart();
    h.breakReads(odd, 'something unexpected');

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toContain('Odd');
    expect(rows(h.ui.picker)).toContain('Alpha');
    expect(h.ui.pickerBusy).toBe(false);
    expect(
      h.logger.entries.some(
        (e) => e.level === 'error' && e.message.includes('something unexpected'),
      ),
    ).toBe(true);
  });

  it('shows the newer scan when an older one ends after it, and keeps that one in the cache', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Alpha/intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    const olderScan = h.holdFirstRead(join(learning, 'Alpha'));
    void h.core.pickCourse();
    await h.ui.pickerOpened();
    await olderScan.reached;
    await h.folder('Learning/Beta', { 'intro.mp4': 'v' });

    h.ui.pressToolbar('Refresh');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
    olderScan.release();
    await h.settle();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
    expect(h.ui.pickerBusy).toBe(false);
    h.ui.dismissPicker();
    h.restart();
    const finishScan = h.holdReads(learning);
    void h.core.pickCourse();
    await h.ui.pickerOpened();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Beta', 'Add Courses root…']);
    finishScan();
  });
});
