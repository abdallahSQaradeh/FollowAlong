import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** Opens a Course with two Lessons; the player is not ready yet. */
async function openCourse(h: Harness): Promise<void> {
  const course = await h.folder('course', { [lessonId]: 'video', '02 Next.webm': 'video' });
  await h.core.openCourse(course);
}

/** Where the player was last shown. */
function lastSpot(h: Harness): string | undefined {
  return h.player.shown.at(-1)?.spot;
}

describe('where a Lesson opens', () => {
  it('opens in an editor group beside the code by default', async () => {
    const h = await createHarness();

    await openCourse(h);

    expect(lastSpot(h)).toBe('editorSplit');
  });

  it('opens in the spot the followalong.videoLocation setting names', async () => {
    const h = await createHarness();
    h.config.set('videoLocation', 'secondarySidebar');

    await openCourse(h);

    expect(lastSpot(h)).toBe('secondarySidebar');
  });

  it('opens beside the code when the setting names no spot FollowAlong knows', async () => {
    const h = await createHarness();
    h.config.set('videoLocation', 'ceiling');

    await openCourse(h);

    expect(lastSpot(h)).toBe('editorSplit');
  });
});
