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

/** Opens the Course in a ready player, playing its first Lesson at 1.5× and zoomed in. */
async function playingZoomed(h: Harness): Promise<void> {
  await openCourse(h);
  h.player.ready();
  h.player.emit({ type: 'played', lessonId });
  h.player.emit({ type: 'timeUpdate', lessonId, position: 42, duration: 300 });
  h.player.emit({ type: 'rateChanged', lessonId, rate: 1.5 });
  h.player.emit({ type: 'zoomChanged', level: 2 });
  h.player.clearSent();
}

describe('Move video to…', () => {
  it('lists the spots, and moves the player to the one picked, carrying time, speed, play and zoom', async () => {
    const h = await createHarness();
    await playingZoomed(h);

    const moving = h.core.moveVideo();
    await h.ui.pickerShown();
    expect(h.ui.picker?.entries.map((entry) => entry.label)).toEqual([
      'Editor group beside the code',
      'Bottom panel',
      'Secondary sidebar',
    ]);
    h.ui.choose('Bottom panel');
    // The page the video leaves says what it shows.
    await Promise.resolve();
    expect(h.player.sent).toEqual([{ type: 'takeSnapshot' }]);
    h.player.emit({
      type: 'snapshot',
      snapshot: {
        rate: 1.5,
        zoom: { level: 2, left: 0.25, top: 0.5 },
        lesson: { lessonId, position: 42.5, playing: true },
      },
    });
    await moving;
    h.player.clearSent();

    expect(lastSpot(h)).toBe('bottomPanel');
    // The page in the new spot starts, then takes over where the old one was.
    h.player.ready();
    expect(h.player.sent).toEqual([
      expect.objectContaining({ type: 'load', lessonId, startAt: 42.5, autoplay: true }),
      { type: 'setRate', rate: 1.5 },
      { type: 'restore', zoom: { level: 2, left: 0.25, top: 0.5 } },
    ]);
  });
});
