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

  it('lists every Course under the Courses roots A–Z, then “Add Courses root…”', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'TypeScript Deep Dive/01 Intro.mp4': 'v',
      'algorithms/lesson1.webm': 'v',
      'Web/React Basics/01 Hello.webm': 'v',
      'notes/readme.txt': 'not a Course',
    });
    const more = await h.folder('More', { 'CSS Grid/lesson10.mp4': 'v' });
    h.config.set('coursesRoots', [learning, more]);

    void h.core.pickCourse();
    await settle();

    expect(rows(h.ui.picker)).toEqual([
      'algorithms',
      'CSS Grid',
      'React Basics',
      'TypeScript Deep Dive',
      'Add Courses root…',
    ]);
  });

  it('stops at the first folder on a branch that holds a video: its subfolders are its Sections', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Node Course/01 Welcome.mp4': 'v',
      'Node Course/Section 2/02 Modules.mp4': 'v',
      'Node Course/Section 2/extra/03 Deep.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);

    void h.core.pickCourse();
    await settle();

    expect(rows(h.ui.picker)).toEqual(['Node Course', 'Add Courses root…']);
  });
});
