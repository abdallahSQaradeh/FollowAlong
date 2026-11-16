import { join } from 'node:path';

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
      'Open “React” as Course',
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

    expect(rows(h.ui.picker)).toEqual(['Up', 'Open “Node” as Course', '01 Intro.mp4']);

    h.ui.choose('Up');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Node']);

    h.ui.choose('Up');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Courses', 'Other']);
  });
});

describe('Open as Course in the Folder browser', () => {
  it('is offered only on folders that directly hold videos', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React/01 Intro.mp4': 'v',
      'Web/Vue/01 Intro.WEBM': 'v',
      'Web/Notes/readme.txt': 'no videos',
      'Web/Zipped/course.zip': 'only a zip',
      'Web/Sections/Part 1/01 Intro.mp4': 'videos only below',
    });
    h.config.set('coursesRoots', [learning]);
    await browse(h);
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    h.ui.choose('Web');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Up', 'Notes', 'React', 'Sections', 'Vue', 'Zipped']);
    expect(h.ui.buttonsOf('React')).toEqual(['Open as Course']);
    expect(h.ui.buttonsOf('Vue')).toEqual(['Open as Course']);
    expect(h.ui.buttonsOf('Notes')).toEqual([]);
    expect(h.ui.buttonsOf('Zipped')).toEqual([]);
    expect(h.ui.buttonsOf('Sections')).toEqual([]);
  });

  it('shows the folders at once and is busy until it knows which ones hold videos', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Web/React/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    await browse(h);
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    const react = join(learning, 'Web', 'React');
    const release = h.holdReads(react);

    h.ui.choose('Web');
    // The folder is read, and listed at once: the first update after the busy one.
    await h.ui.nextUpdate();

    expect(h.ui.pickerBusy).toBe(true);
    expect(rows(h.ui.picker)).toEqual(['Up', 'React']);
    expect(h.ui.buttonsOf('React')).toEqual([]);
    release();
    await h.ui.pickerShown();
    expect(h.ui.buttonsOf('React')).toEqual(['Open as Course']);
  });

  it('opens the folder as the Course when the learner presses it, and closes the picker', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React/01 Intro.mp4': 'v',
      'Web/React/02 State.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    h.ui.choose('Web');
    await h.ui.pickerShown();

    h.ui.press('React', 'Open as Course');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      {
        type: 'load',
        videoUri: h.player.resourceUri(join(learning, 'Web', 'React', '01 Intro.mp4')),
      },
    ]);
    expect(h.ui.picker).toBeUndefined();
  });

  it('is also offered inside a folder that holds videos, for the folder itself', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Web/React/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    h.ui.choose('Web');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'React']);
    h.ui.choose('React');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Up', 'Open “React” as Course', '01 Intro.mp4']);
    h.ui.choose('Open “React” as Course');
    await picking;
    h.player.ready();
    expect(h.player.sent).toMatchObject([{ type: 'load' }]);
  });
});

describe('picking a video in the Folder browser', () => {
  /** Browses to `Learning/<folders>` from the Course picker; resolves the picker's answer. */
  async function walkTo(
    h: Harness,
    root: string,
    ...folders: string[]
  ): Promise<{ readonly picking: Promise<void> }> {
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    for (const label of [root, ...folders]) {
      h.ui.choose(label);
      await h.ui.pickerShown();
    }
    return { picking };
  }

  it('opens its folder as the Course and plays that video, not the first Lesson', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'React/01 Intro.mp4': 'v',
      'React/02 State.mp4': 'v',
      'React/03 Hooks.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    const { picking } = await walkTo(h, 'Learning', 'React');

    h.ui.choose('02 State.mp4');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      {
        type: 'load',
        videoUri: h.player.resourceUri(join(learning, 'React', '02 State.mp4')),
        autoplay: true,
      },
    ]);
    expect(h.ui.selectedLesson).toBe('02 State.mp4');
    expect(h.ui.lessonTree?.nodes.map((node) => node.kind)).toEqual(['lesson', 'lesson', 'lesson']);
    expect(h.ui.picker).toBeUndefined();
  });

  it('plays it from 5 s before where the learner left it, as any picked Lesson does', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'React/01 Intro.mp4': 'v',
      'React/02 State.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'React'));
    h.player.ready();
    h.core.playLesson('02 State.mp4');
    h.player.emit({ type: 'played', lessonId: '02 State.mp4' });
    h.player.emit({ type: 'timeUpdate', lessonId: '02 State.mp4', position: 120, duration: 600 });
    h.player.emit({ type: 'paused', lessonId: '02 State.mp4', byUser: true });
    h.core.playLesson('01 Intro.mp4');
    await h.settle();
    h.restart();
    h.player.clearSent();
    const { picking } = await walkTo(h, 'Learning', 'React');
    h.player.clearSent();

    h.ui.choose('02 State.mp4');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '02 State.mp4', startAt: 115, autoplay: true },
    ]);
  });
});
