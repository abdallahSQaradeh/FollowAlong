import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

function saved(position: number, status: 'done' | 'inProgress' | undefined, duration = 600) {
  return { position, duration, savedAt: 1000, ...(status === undefined ? {} : { status }) };
}

/** The text of a version 1 `progress.json`. */
function progressFile(lessons: Record<string, ReturnType<typeof saved>>): string {
  return JSON.stringify({ version: 1, data: { lessons } });
}

/** A Course of four Lessons whose Progress is: 01 done at its end, 02 in progress, 03 and 04 untouched. */
async function openCourseWithProgress(h: Harness): Promise<string> {
  const course = await h.folder('Course', {
    'Part/01 Intro.mp4': 'v',
    'Part/02 Limits.mp4': 'v',
    'Part/03 Series.mp4': 'v',
    'Other/04 Extra.mp4': 'v',
    '.followalong/progress.json': progressFile({
      'Part/01 Intro.mp4': saved(590, 'done'),
      'Part/02 Limits.mp4': saved(750, 'inProgress', 2405),
    }),
  });
  await h.core.openCourse(course);
  h.player.ready();
  h.player.clearSent();
  return course;
}

/** The items as the learner reads them: label, then the text beside it. */
function items(h: Harness): string[] {
  return (h.ui.picker?.entries ?? []).flatMap((entry) =>
    entry.kind === 'item' ? [`${entry.label} | ${entry.description ?? ''}`] : [],
  );
}

/** Where the last `load` the player was sent starts. */
function lastStart(h: Harness): unknown {
  const load = h.player.sent.findLast((message) => message.type === 'load');
  return load?.type === 'load' ? load.startAt : undefined;
}

describe('Progress in the Lesson picker', () => {
  it('marks each Lesson ✓, ◐ or ○ and shows the saved position of one in progress, beside its Section', async () => {
    const h = await createHarness();
    await openCourseWithProgress(h);

    void h.core.goToLesson();

    expect(items(h)).toEqual([
      '○ Extra | Other',
      '✓ Intro | Part',
      '◐ Limits | Part  ·  12:30 / 40:05',
      '○ Series | Part',
    ]);
  });

  it('still narrows to a Section by its name: the Section stays in the matched description', async () => {
    const h = await createHarness();
    await openCourseWithProgress(h);

    void h.core.goToLesson();

    expect(h.ui.picker).toMatchObject({ matchOnDescription: true });
    expect(h.ui.picker?.entries).toContainEqual(
      expect.objectContaining({ description: 'Part  ·  12:30 / 40:05' }),
    );
    expect(h.ui.picker?.entries).toContainEqual(expect.objectContaining({ description: 'Other' }));
  });

  it('plays a Lesson in progress from 5 s before its saved position, right away', async () => {
    const h = await createHarness();
    await openCourseWithProgress(h);

    const going = h.core.goToLesson();
    h.ui.choose('◐ Limits');
    await going;

    expect(lastStart(h)).toBe(745);
    expect(h.player.sent.at(-1)).toMatchObject({ type: 'load', autoplay: true });
  });

  it('plays a done Lesson saved in its last 5% from 0:00', async () => {
    const h = await createHarness();
    await openCourseWithProgress(h);

    const going = h.core.goToLesson();
    h.ui.choose('✓ Intro');
    await going;

    expect(lastStart(h)).toBe(0);
  });

  it('plays a Lesson nobody played from 0:00', async () => {
    const h = await createHarness();
    await openCourseWithProgress(h);

    const going = h.core.goToLesson();
    h.ui.choose('○ Series');
    await going;

    expect(lastStart(h)).toBe(0);
  });

  it('offers Start from beginning beside each Lesson, and it plays the Lesson from 0:00, closing the picker', async () => {
    const h = await createHarness();
    const course = await openCourseWithProgress(h);

    const going = h.core.goToLesson();
    expect(h.ui.buttonsOf('◐ Limits')).toEqual(['Start from beginning']);
    h.ui.press('◐ Limits', 'Start from beginning');
    await going;

    expect(h.player.sent).toEqual([
      expect.objectContaining({
        type: 'load',
        lessonId: 'Part/02 Limits.mp4',
        videoUri: h.player.resourceUri(join(course, 'Part', '02 Limits.mp4')),
        startAt: 0,
        autoplay: true,
      }),
    ]);
    expect(h.ui.picker).toBeUndefined();
  });
});
