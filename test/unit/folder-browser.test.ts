import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';

/** The quick pick as the learner reads it, top to bottom: a separator as `── label`, an item as its label. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator' ? `── ${entry.label}` : entry.label,
  );
}

/** Opens the Course picker and picks “Browse…”: the learner is in the Folder browser. */
async function browse(h: Harness): Promise<void> {
  void h.core.pickCourse();
  await h.ui.pickerShown();
  h.ui.choose('Browse…');
  await h.ui.pickerShown();
}

describe('Browse… in the Course picker', () => {
  it('walks the Courses roots in the same quick pick, with a way back to the Courses', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Node/01 Intro.mp4': 'v' });
    const more = await h.folder('More', {});
    h.config.set('coursesRoots', [learning, more]);

    await browse(h);

    expect(rows(h.ui.picker)).toEqual(['Back to Courses', 'Learning', 'More']);
    expect(h.ui.pickers).toHaveLength(1);
  });
});
