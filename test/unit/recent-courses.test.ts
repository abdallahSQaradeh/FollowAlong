import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';

/** The picker as the learner reads it: a separator as `── label`, an item as label and description. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) => {
    if (entry.kind === 'separator') {
      return `── ${entry.label}`;
    }
    return entry.description === undefined ? entry.label : `${entry.label} — ${entry.description}`;
  });
}

/** A Courses root holding one Course per name, and the Courses roots setting pointing at it. */
async function learning(h: Harness, names: readonly string[]): Promise<Record<string, string>> {
  const tree = Object.fromEntries(names.map((name) => [`${name}/01 Intro.webm`, 'v']));
  const root = await h.folder('Learning', tree);
  h.config.set('coursesRoots', [root]);
  return Object.fromEntries(names.map((name) => [name, join(root, name)]));
}

describe('Recent Courses in the Course picker', () => {
  it('lists the 5 most recently opened Courses first, newest first, above the other Courses', async () => {
    const h = await createHarness();
    const folders = await learning(h, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    for (const name of ['F', 'A', 'G', 'C', 'B', 'E']) {
      await h.core.openCourse(folders[name] ?? '');
    }

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'E — (open)',
      'B',
      'C',
      'G',
      'A',
      '── Other Courses',
      'D',
      'F',
      'Add Courses root…',
    ]);
  });
});
