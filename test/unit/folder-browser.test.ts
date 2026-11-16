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

describe('walking folders in the Folder browser', () => {
  it('lists a folder’s subfolders and then its videos, in natural order, and nothing else', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React/lesson10.mp4': 'v',
      'Web/React/lesson2.mp4': 'v',
      'Web/React/Intro.WEBM': 'v',
      'Web/React/notes.pdf': 'not a video',
      'Web/React/slides/s1.pdf': 'a folder without videos is still a folder',
      'Web/React/.git/config': 'hidden',
      'Web/React/node_modules/x.mp4': 'never walked',
      'Web/Vue/lesson1.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await browse(h);

    h.ui.choose('Learning');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Web']);

    h.ui.choose('Web');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'React', 'Vue']);

    h.ui.choose('React');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual([
      'Up',
      'slides',
      'Intro.WEBM',
      'lesson2.mp4',
      'lesson10.mp4',
    ]);
    expect(h.ui.pickers).toHaveLength(1);
  });

  it('goes back up one folder at a time, also above a Courses root', async () => {
    const h = await createHarness();
    const courses = await h.folder('Library/Courses', { 'Node/01 Intro.mp4': 'v' });
    await h.folder('Library/Other', { 'x/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [courses]);
    await browse(h);
    h.ui.choose('Courses');
    await h.ui.pickerShown();
    h.ui.choose('Node');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Up', '01 Intro.mp4']);

    h.ui.choose('Up');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Node']);

    h.ui.choose('Up');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Courses', 'Other']);
  });
});
