import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness } from './harness.js';

/** The picker as the learner reads it, top to bottom: a separator as `── label`, an item as its label. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator' ? `── ${entry.label}` : entry.label,
  );
}

/** Lets the core's file system reads and writes run until the next quick pick or dialog. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('the Course picker', () => {
  it('offers only “Add Courses root…” while no Courses root is set', async () => {
    const h = await createHarness();

    void h.core.pickCourse();
    await settle();

    expect(rows(h.ui.picker)).toEqual(['Add Courses root…']);
  });

  it('writes the folder the learner chooses for “Add Courses root…” to the setting', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', {});
    h.ui.folderAnswers.push(root);

    void h.core.pickCourse();
    await settle();
    h.ui.choose('Add Courses root…');
    await settle();

    expect(h.ui.folderDialogs).toEqual([{ title: 'Add Courses root', openLabel: 'Add' }]);
    expect(h.config.get('coursesRoots')).toEqual([root]);
  });
});
