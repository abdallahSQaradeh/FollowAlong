import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness } from './harness.js';

/**
 * The picker as the learner reads it, top to bottom: a separator as `── Section`, an item as
 * `glyph title  ·  Section` (just the glyph and title when it shows no Section).
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
      '○ Welcome  ·  Section 1',
      '○ Setup  ·  Section 1',
      '── Section 2',
      '○ Tools  ·  Section 2',
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
    h.player.clearSent();

    const going = h.core.goToLesson();
    h.ui.choose('○ Tools');
    await going;

    expect(h.player.shown.at(-1)?.title).toBe('Tools');
    expect(h.player.sent).toEqual([
      {
        type: 'load',
        lessonId: 'Section 2/03 Tools.mp4',
        videoUri: h.player.resourceUri(join(course, 'Section 2', '03 Tools.mp4')),
        container: 'mp4',
        startAt: 0,
        autoplay: true,
        loadId: 2,
      },
    ]);
  });

  it('plays nothing when the learner closes the picker without picking', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'Section 1/01 Welcome.webm': 'v' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.clearSent();

    const going = h.core.goToLesson();
    h.ui.dismissPicker();
    await going;

    expect(h.player.sent).toEqual([]);
  });

  it('opens the Course picker instead when no Course is open, so the key is never a dead end', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Some Course/intro.webm': 'v' });
    h.config.set('coursesRoots', [learning]);

    void h.core.goToLesson();
    await h.ui.pickerShown();

    expect(h.ui.picker?.title).toBe('Open Course');
    expect(rows(h.ui.picker)).toEqual(['Some Course', 'Browse…', 'Add Courses root…']);
    expect(h.ui.messages).toEqual([]);
  });

  it('plays nothing when another Course was opened while the picker was open', async () => {
    const h = await createHarness();
    const first = await h.folder('First', { 'Part 1/intro.webm': 'v' });
    const second = await h.folder('Second', { 'Part 1/intro.webm': 'v', 'Part 1/other.webm': 'v' });
    await h.core.openCourse(first);
    h.player.ready();

    const going = h.core.goToLesson();
    await h.core.openCourse(second);
    h.player.ready();
    h.player.clearSent();
    h.ui.choose('○ intro');
    await going;

    expect(h.player.sent).toEqual([]);
  });

  it('lists Lessons that sit in the Course folder first, without a Section', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.mp4': 'v',
      'lesson10.mp4': 'v',
      'lesson2.mp4': 'v',
      'Basics/01 Variables.mp4': 'v',
    });
    await h.core.openCourse(course);

    void h.core.goToLesson();

    expect(rows(h.ui.picker)).toEqual([
      '○ intro',
      '○ lesson2',
      '○ lesson10',
      '── Basics',
      '○ Variables  ·  Basics',
    ]);
  });

  it('names a nested Section by its path, keeping the name of a wrapper folder, and leaves out folders without Lessons', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Part 1/Basics/01 Variables.mp4': 'v',
      'Part 1/Basics/Deep/02 Types.mp4': 'v',
      'Part 1/Basics/Images/readme.txt': 'text',
      'Part 2/Wrapper/Only/03 Loops.mp4': 'v',
      'Part 2/04 Recap.mp4': 'v',
    });
    await h.core.openCourse(course);

    void h.core.goToLesson();

    expect(rows(h.ui.picker)).toEqual([
      '── Part 1',
      '○ Variables  ·  Part 1',
      '── Part 1 / Deep',
      '○ Types  ·  Part 1 / Deep',
      '── Part 2',
      '○ Recap  ·  Part 2',
      '── Part 2 / Wrapper',
      '○ Loops  ·  Part 2 / Wrapper',
    ]);
  });

  it('shows the Section of each Lesson, and has the quick pick match it, so typing a Section name narrows the list', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Closures/01 Scope.mp4': 'v',
      'Types/02 Coercion.mp4': 'v',
    });
    await h.core.openCourse(course);

    void h.core.goToLesson();

    expect(h.ui.picker).toMatchObject({ matchOnDescription: true });
    expect(h.ui.picker?.entries).toContainEqual(
      expect.objectContaining({ description: 'Closures' }),
    );
  });
});
