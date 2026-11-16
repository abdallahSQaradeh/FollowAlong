import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness } from './harness.js';

/**
 * The picker as the learner reads it, top to bottom: a separator as `── Section`, an item as
 * `title  ·  Section` (just the title when it shows no Section).
 */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator'
      ? `── ${entry.label}`
      : entry.description === undefined
        ? entry.label
        : `${entry.label}  ·  ${entry.description}`,
  );
}

describe('Go to Lesson…', () => {
  it('lists the Lessons of the open Course grouped by Section, with a separator for each', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Section 1/01 Welcome.webm': 'v',
      'Section 1/02 Setup.mp4': 'v',
      'Section 2/03 Tools.mp4': 'v',
    });
    await h.core.openCourse(course);

    void h.core.goToLesson();

    expect(rows(h.ui.picker)).toEqual([
      '── Section 1',
      '01 Welcome.webm  ·  Section 1',
      '02 Setup.mp4  ·  Section 1',
      '── Section 2',
      '03 Tools.mp4  ·  Section 2',
    ]);
  });

  it('plays the Lesson the learner picks, right away', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Section 1/01 Welcome.webm': 'v',
      'Section 2/03 Tools.mp4': 'v',
    });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.sent.length = 0;

    const going = h.core.goToLesson();
    h.ui.choose('03 Tools.mp4');
    await going;

    expect(h.player.shown.at(-1)?.title).toBe('03 Tools.mp4');
    expect(h.player.sent).toEqual([
      {
        type: 'load',
        lessonId: 'Section 2/03 Tools.mp4',
        videoUri: h.player.resourceUri(join(course, 'Section 2', '03 Tools.mp4')),
        container: 'mp4',
        startAt: 0,
        autoplay: true,
      },
    ]);
  });

  it('plays nothing when the learner closes the picker without picking', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'Section 1/01 Welcome.webm': 'v' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.sent.length = 0;

    const going = h.core.goToLesson();
    h.ui.dismissPicker();
    await going;

    expect(h.player.sent).toEqual([]);
  });
});
