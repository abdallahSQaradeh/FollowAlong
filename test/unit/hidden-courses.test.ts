import { readdir, rm } from 'node:fs/promises';
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

/** A Courses root with a real Course and a stray folder holding one video. */
async function coursesRootWithStray(h: Harness): Promise<string> {
  const learning = await h.folder('Learning', {
    'Alpha/intro.mp4': 'v',
    'Stray/images/clip.mp4': 'v',
  });
  h.config.set('coursesRoots', [learning]);
  return learning;
}

describe('hiding a stray folder from the Course picker', () => {
  it('offers a Hide button on a Course', async () => {
    const h = await createHarness();
    await coursesRootWithStray(h);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Stray', 'Browse…', 'Add Courses root…']);
    expect(h.ui.buttonsOf('Stray')).toEqual(['Open in new window', 'Hide']);
    expect(h.ui.buttonsOf('Add Courses root…')).toEqual([]);
  });

  it('removes the entry when the learner presses Hide, and the picker stays open', async () => {
    const h = await createHarness();
    await coursesRootWithStray(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();

    h.ui.press('Stray', 'Hide');

    expect(h.ui.picker).toBeDefined();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Browse…', 'Add Courses root…']);
  });

  it('leaves the Course folder as it was', async () => {
    const h = await createHarness();
    const learning = await coursesRootWithStray(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();

    h.ui.press('Stray', 'Hide');
    await h.ui.pickerShown();

    expect(await readdir(join(learning, 'Stray'))).toEqual(['images']);
    expect(await readdir(join(learning, 'Stray', 'images'))).toEqual(['clip.mp4']);
  });

  it('stays hidden after a Refresh, which rescans the Courses roots', async () => {
    const h = await createHarness();
    await coursesRootWithStray(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.press('Stray', 'Hide');

    h.ui.pressToolbar('Refresh');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Browse…', 'Add Courses root…']);
  });

  it('stays hidden after a restart, and the next open does not list it even from the cache', async () => {
    const h = await createHarness();
    await coursesRootWithStray(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.press('Stray', 'Hide');
    await h.ui.pickerShown();
    h.ui.dismissPicker();

    h.restart();
    void h.core.pickCourse();
    await h.ui.pickerOpened();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Browse…', 'Add Courses root…']);
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Browse…', 'Add Courses root…']);
  });

  it('keeps the other Courses and hides each folder on its own', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Alpha/intro.mp4': 'v',
      'Beta/intro.mp4': 'v',
      'Gamma/intro.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    void h.core.pickCourse();
    await h.ui.pickerShown();

    h.ui.press('Beta', 'Hide');
    h.ui.press('Alpha', 'Hide');

    expect(rows(h.ui.picker)).toEqual(['Gamma', 'Browse…', 'Add Courses root…']);
  });

  it('hides a Recent Course from Recent as well, and Unhide gives it back its place in Recent', async () => {
    const h = await createHarness();
    const learning = await coursesRootWithStray(h);
    await h.core.openCourse(join(learning, 'Stray'));
    void h.core.pickCourse();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'Stray',
      '── Other Courses',
      'Alpha',
      'Browse…',
      'Add Courses root…',
    ]);

    h.ui.press('Stray', 'Hide');

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Browse…', 'Add Courses root…']);
    h.ui.dismissPicker();
    const unhiding = h.core.unhideCourse();
    await h.ui.pickerShown();
    h.ui.choose('Stray');
    await unhiding;
    void h.core.pickCourse();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'Stray',
      '── Other Courses',
      'Alpha',
      'Browse…',
      'Add Courses root…',
    ]);
  });

  it('hides the open Course too, and it is still open', async () => {
    const h = await createHarness();
    const learning = await coursesRootWithStray(h);
    await h.core.openCourse(join(learning, 'Alpha'));
    void h.core.pickCourse();
    await h.ui.pickerShown();

    h.ui.press('Alpha', 'Hide');

    expect(rows(h.ui.picker)).toEqual(['Stray', 'Browse…', 'Add Courses root…']);
    h.player.ready();
    expect(h.player.sent).toMatchObject([{ type: 'load' }]);
  });

  it('has no Hide button on a missing Recent Course, which has Locate… and Remove', async () => {
    const h = await createHarness();
    const learning = await coursesRootWithStray(h);
    await h.core.openCourse(join(learning, 'Alpha'));
    await rm(join(learning, 'Alpha'), { recursive: true });

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(h.ui.buttonsOf('Alpha')).toEqual(['Locate…', 'Remove']);
  });

  it('hides the Course for now, and logs a warning, when the global storage refuses the write', async () => {
    const h = await createHarness();
    await coursesRootWithStray(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.failNextWrite('global', 'disk full');

    h.ui.press('Stray', 'Hide');
    await h.settle();

    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Browse…', 'Add Courses root…']);
    expect(
      h.logger.entries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('hidden Courses'),
      ),
    ).toBe(true);
  });
});

describe('unhiding a Course', () => {
  async function hideStray(h: Harness): Promise<string> {
    const learning = await coursesRootWithStray(h);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.press('Stray', 'Hide');
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    return learning;
  }

  it('says so when no Course is hidden', async () => {
    const h = await createHarness();

    await h.core.unhideCourse();

    expect(h.ui.messages).toEqual([{ severity: 'info', text: 'No Courses are hidden.' }]);
    expect(h.ui.pickers).toEqual([]);
  });

  it('lists the hidden Courses by name and folder', async () => {
    const h = await createHarness();
    const learning = await hideStray(h);

    void h.core.unhideCourse();
    await h.ui.pickerShown();

    expect(h.ui.picker?.entries).toMatchObject([
      { kind: 'item', label: 'Stray', description: join(learning, 'Stray', 'images') },
    ]);
  });

  it('shows the Course in the picker again once the learner picks it, and tells them', async () => {
    const h = await createHarness();
    await hideStray(h);

    const unhiding = h.core.unhideCourse();
    await h.ui.pickerShown();
    h.ui.choose('Stray');
    await unhiding;

    expect(h.ui.messages).toEqual([{ severity: 'info', text: '“Stray” is no longer hidden.' }]);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Stray', 'Browse…', 'Add Courses root…']);
  });

  it('keeps the other hidden Courses hidden, and the Course hidden when the learner closes the list', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Alpha/intro.mp4': 'v',
      'Beta/intro.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.press('Alpha', 'Hide');
    h.ui.press('Beta', 'Hide');
    h.ui.dismissPicker();

    void h.core.unhideCourse();
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    h.restart();
    const unhiding = h.core.unhideCourse();
    await h.ui.pickerShown();
    h.ui.choose('Alpha');
    await unhiding;

    void h.core.pickCourse();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Alpha', 'Browse…', 'Add Courses root…']);
  });
});
