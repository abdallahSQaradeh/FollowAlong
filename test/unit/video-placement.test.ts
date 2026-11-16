import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
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

describe('Move video to… when the page cannot say what it shows', () => {
  it('moves after 1 s with what FollowAlong knows, at the whole picture', async () => {
    const h = await createHarness();
    await playingZoomed(h);

    const moving = h.core.moveVideo('secondarySidebar');
    h.clock.advance(999);
    expect(lastSpot(h)).toBe('editorSplit');
    h.clock.advance(1);
    await moving;
    h.player.clearSent();

    expect(lastSpot(h)).toBe('secondarySidebar');
    h.player.ready();
    expect(h.player.sent).toEqual([
      expect.objectContaining({ type: 'load', lessonId, startAt: 42, autoplay: true }),
      { type: 'setRate', rate: 1.5 },
      { type: 'restore', zoom: { level: 1, left: 0, top: 0 } },
    ]);
  });

  it('moves at once a page that is still starting, and loads the Lesson where it was to start', async () => {
    const h = await createHarness();
    await openCourse(h);

    await h.core.moveVideo('bottomPanel');

    expect(h.player.sent).toEqual([]);
    expect(lastSpot(h)).toBe('bottomPanel');
    h.player.ready();
    expect(h.player.sent).toEqual([
      expect.objectContaining({ type: 'load', lessonId, startAt: 0, autoplay: true }),
      { type: 'restore', zoom: { level: 1, left: 0, top: 0 } },
    ]);
  });
});

describe('Move video to… does nothing', () => {
  it('but say so while no Lesson is loaded', async () => {
    const h = await createHarness();

    await h.core.moveVideo();

    expect(h.ui.pickers).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'FollowAlong: no Lesson is open. Open a Course first.' },
    ]);
  });

  it('when the learner picks the spot the video is in, which the picker marks', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const shows = h.player.shown.length;

    const moving = h.core.moveVideo();
    await h.ui.pickerShown();
    expect(h.ui.picker?.entries[0]).toMatchObject({
      label: 'Editor group beside the code',
      description: 'where it is now',
    });
    h.ui.choose('Editor group beside the code');
    await moving;

    expect(h.player.sent).toEqual([]);
    expect(h.player.shown).toHaveLength(shows);
  });

  it('when the learner closes the picker', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const shows = h.player.shown.length;

    const moving = h.core.moveVideo();
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    await moving;

    expect(h.player.sent).toEqual([]);
    expect(h.player.shown).toHaveLength(shows);
  });
});

describe('after a move', () => {
  it('the next Lesson plays in the spot the video was moved to', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const moving = h.core.moveVideo('bottomPanel');
    h.player.emit({
      type: 'snapshot',
      snapshot: {
        rate: 1,
        zoom: { level: 1, left: 0, top: 0 },
        lesson: { lessonId, position: 50, playing: false },
      },
    });
    await moving;
    h.player.ready();

    h.core.nextLesson();

    expect(lastSpot(h)).toBe('bottomPanel');
  });

  it('a player the learner closed opens again in the spot the setting names', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const moving = h.core.moveVideo('bottomPanel');
    h.clock.advance(1000);
    await moving;

    h.player.close();
    h.core.playLesson('02 Next.webm');

    expect(lastSpot(h)).toBe('editorSplit');
  });
});

/** The text the Lesson tree shows beside the Lesson with this id. */
function descriptionOf(h: Harness, id: string): string | undefined {
  const walk = (nodes: readonly LessonTreeNode[]): LessonTreeNode[] =>
    nodes.flatMap((node) => [node, ...(node.kind === 'section' ? walk(node.children) : [])]);
  const node = walk(h.ui.lessonTree?.nodes ?? []).find((each) => each.id === id);
  return node?.kind === 'resource' ? undefined : node?.description;
}

describe('Progress across a move', () => {
  it('is saved at once with the playhead the page reported, so a crash right after keeps it', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.ready();
    h.player.emit({ type: 'played', lessonId });
    for (let position = 0; position <= 12; position += 2) {
      h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 300 });
    }

    const moving = h.core.moveVideo('secondarySidebar');
    h.player.emit({
      type: 'snapshot',
      snapshot: {
        rate: 1,
        zoom: { level: 1, left: 0, top: 0 },
        lesson: { lessonId, position: 20, playing: true },
      },
    });
    await moving;
    await h.settle();
    h.restart();
    await h.core.restoreCourse();

    expect(descriptionOf(h, lessonId)).toBe('00:20 / 05:00');
  });
});

describe('sound for an MP4 Lesson across a move', () => {
  it('goes to the page in the new spot once it is ready, never to the page that is gone', async () => {
    const h = await createHarness();
    const mp4 = 'Section 1/01 Intro.mp4';
    const course = await h.folder('mp4 course', { [mp4]: 'mp4 video with AAC sound' });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();

    // The page in the bottom panel is still starting when the sound is ready.
    const moving = h.core.moveVideo('bottomPanel');
    h.clock.advance(1000);
    await moving;
    h.player.clearSent();
    await h.converter.requests[0]?.succeed();
    await h.settle();
    expect(h.player.sent).toEqual([]);

    h.player.ready(false);
    await h.settle();
    expect(h.player.sent.map((command) => command.type)).toEqual(['load', 'restore', 'soundReady']);
  });
});

describe('zoom across a move', () => {
  it('is restored at the whole picture too, so a view spot used before never shows its old zoom', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.ready();
    h.player.clearSent();

    const moving = h.core.moveVideo('bottomPanel');
    h.player.emit({
      type: 'snapshot',
      snapshot: {
        rate: 1,
        zoom: { level: 1, left: 0, top: 0 },
        lesson: { lessonId, position: 0, playing: false },
      },
    });
    await moving;
    h.player.clearSent();
    h.player.ready();

    expect(h.player.sent).toEqual([
      expect.objectContaining({ type: 'load', lessonId }),
      { type: 'restore', zoom: { level: 1, left: 0, top: 0 } },
    ]);
  });
});
