import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';

/** The picker as the learner reads it, top to bottom: a separator as `── label`, an item as its label. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator' ? `── ${entry.label}` : entry.label,
  );
}

/** A Courses root with one Course, `Alpha`, opened once so the scan cache holds it. */
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
});
