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

/** Moves the playing, zoomed Lesson to the bottom panel; the page there is ready, nothing sent yet. */
async function movedPlaying(h: Harness): Promise<void> {
  await playingZoomed(h);
  const moving = h.core.moveVideo('bottomPanel');
  h.player.emit({
    type: 'snapshot',
    snapshot: {
      rate: 1,
      zoom: { level: 1, left: 0, top: 0 },
      lesson: { lessonId, position: 42, playing: true },
    },
  });
  await moving;
  h.player.clearSent();
  h.player.ready();
}

describe('a playing Lesson after a move', () => {
  it('plays on in the new spot when VS Code lets the new page start it, without a word', async () => {
    const h = await createHarness();
    await movedPlaying(h);
    expect(h.player.sent[0]).toMatchObject({ type: 'load', autoplay: true });

    h.player.emit({ type: 'played', lessonId });

    expect(h.ui.messages).toEqual([]);
    expect(h.ui.statusBar.items.find((item) => item.id === 'playPause')?.icon).toBe('pause');
  });

  it('waits paused for a click when VS Code refuses the new page, and says so once', async () => {
    const h = await createHarness();
    await movedPlaying(h);

    h.player.emit({ type: 'paused', lessonId, byUser: false });

    expect(h.ui.messages).toEqual([
      {
        severity: 'info',
        text: 'VS Code did not let “Intro” start by itself. Press play in the player to start it.',
      },
    ]);
  });
});

describe('a Lesson that had ended, moved', () => {
  it('lands paused at its end in the new spot', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    h.player.emit({ type: 'timeUpdate', lessonId, position: 300, duration: 300 });
    h.player.emit({ type: 'ended', lessonId });
    h.player.clearSent();

    const moving = h.core.moveVideo('secondarySidebar');
    h.player.emit({
      type: 'snapshot',
      snapshot: {
        rate: 1.5,
        zoom: { level: 2, left: 0.25, top: 0.5 },
        lesson: { lessonId, position: 300, playing: false },
      },
    });
    await moving;
    h.player.clearSent();
    h.player.ready();

    expect(h.player.sent[0]).toMatchObject({ type: 'load', startAt: 300, autoplay: false });
  });

  it('lands paused at its end when the page does not answer either', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    h.player.emit({ type: 'timeUpdate', lessonId, position: 300, duration: 300 });
    h.player.emit({ type: 'ended', lessonId });

    const moving = h.core.moveVideo('secondarySidebar');
    h.clock.advance(1000);
    await moving;
    h.player.clearSent();
    h.player.ready();

    expect(h.player.sent[0]).toMatchObject({ type: 'load', startAt: 300, autoplay: false });
  });
});

/** The page answers the `takeSnapshot` of a move with this Lesson playhead, at 1.5× and zoomed. */
function answerSnapshot(h: Harness, position: number, playing: boolean): void {
  h.player.emit({
    type: 'snapshot',
    snapshot: {
      rate: 1.5,
      zoom: { level: 2, left: 0.25, top: 0.5 },
      lesson: { lessonId, position, playing },
    },
  });
}

describe('two moves in a row', () => {
  it('carry the speed and zoom of the first page when the second page was not ready yet', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const first = h.core.moveVideo('bottomPanel');
    answerSnapshot(h, 42, true);
    await first;

    // The page in the bottom panel is still starting: no snapshot, and nothing of it is lost.
    await h.core.moveVideo('secondarySidebar');
    h.player.clearSent();
    h.player.ready();

    expect(lastSpot(h)).toBe('secondarySidebar');
    expect(h.player.sent).toEqual([
      expect.objectContaining({ type: 'load', lessonId, startAt: 42, autoplay: true }),
      { type: 'setRate', rate: 1.5 },
      { type: 'restore', zoom: { level: 2, left: 0.25, top: 0.5 } },
    ]);
  });

  it('end in the spot asked for last, when the second is asked while the first waits for its snapshot', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const shows = h.player.shown.length;

    const first = h.core.moveVideo('bottomPanel');
    const second = h.core.moveVideo('secondarySidebar');
    answerSnapshot(h, 42, true);
    await Promise.all([first, second]);

    expect(h.player.shown.slice(shows).map((shown) => shown.spot)).toEqual(['secondarySidebar']);
  });
});

describe('a Lesson that had ended, moved, then resumed', () => {
  it('starts again from the top, without a Rewind', async () => {
    const h = await createHarness();
    h.config.set('resumeRewind', 5);
    await playingZoomed(h);
    h.player.emit({ type: 'timeUpdate', lessonId, position: 300, duration: 300 });
    h.player.emit({ type: 'ended', lessonId });
    const moving = h.core.moveVideo('bottomPanel');
    answerSnapshot(h, 300, false);
    await moving;
    h.player.ready();
    // The new page applies the start position (its own seek), and reports the Lesson's end.
    h.player.emit({ type: 'timeUpdate', lessonId, position: 300, duration: 300 });
    h.player.emit({ type: 'seeked', lessonId, startSeek: true });
    h.player.clearSent();

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'play' }]);
  });
});

describe('a Lesson still waiting to autoplay, moved by a page that does not answer', () => {
  it('still asks the new page to play it', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.ready();
    // Loaded with autoplay; the page has not said it plays yet (an MP4's sound may be preparing).

    const moving = h.core.moveVideo('bottomPanel');
    h.clock.advance(1000);
    await moving;
    h.player.clearSent();
    h.player.ready();

    expect(h.player.sent[0]).toMatchObject({ type: 'load', lessonId, autoplay: true });
  });
});

describe('the page a move left', () => {
  it('changes neither Progress nor the status bar with a late event', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.ready();
    h.player.emit({ type: 'played', lessonId });
    for (let position = 0; position <= 20; position += 2) {
      h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 300 });
    }
    const moving = h.core.moveVideo('bottomPanel');
    answerSnapshot(h, 20, true);
    await moving;
    await h.settle();
    const tree = descriptionOf(h, lessonId);
    const statusBar = h.ui.statusBar;

    // The old page's last words, with its loadId, before the new page is ready.
    h.player.emit({ type: 'timeUpdate', lessonId, loadId: 1, position: 0, duration: 300 });
    h.player.emit({ type: 'paused', lessonId, loadId: 1, byUser: true });
    await h.settle();

    expect(descriptionOf(h, lessonId)).toBe(tree);
    expect(h.ui.statusBar).toEqual(statusBar);
  });
});

describe('Toggle video', () => {
  it('collapses the video, and restores it in the same spot with its time, speed, play and zoom', async () => {
    const h = await createHarness();
    await movedPlaying(h);
    h.player.emit({ type: 'timeUpdate', lessonId, position: 42, duration: 300 });
    h.player.emit({ type: 'rateChanged', lessonId, rate: 1.5 });
    h.player.emit({ type: 'zoomChanged', level: 2 });
    h.player.clearSent();
    const shows = h.player.shown.length;

    const collapsing = h.core.toggleVideo();
    expect(h.player.sent).toEqual([{ type: 'takeSnapshot' }]);
    answerSnapshot(h, 42.5, true);
    await collapsing;

    expect(h.player.hidden).toBe(true);
    expect(h.player.shown).toHaveLength(shows);

    await h.core.toggleVideo();
    h.player.clearSent();

    expect(h.player.hidden).toBe(false);
    expect(lastSpot(h)).toBe('bottomPanel');
    h.player.ready();
    expect(h.player.sent).toEqual([
      expect.objectContaining({ type: 'load', lessonId, startAt: 42.5, autoplay: true }),
      { type: 'setRate', rate: 1.5 },
      { type: 'restore', zoom: { level: 2, left: 0.25, top: 0.5 } },
    ]);
  });
});

describe('Toggle video does nothing', () => {
  it('but say so while no Lesson is loaded', async () => {
    const h = await createHarness();

    await h.core.toggleVideo();

    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'FollowAlong: no Lesson is open. Open a Course first.' },
    ]);
  });
});

describe('a collapsed video', () => {
  it('restores a paused Lesson paused, at the position it had', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const collapsing = h.core.toggleVideo();
    answerSnapshot(h, 61, false);
    await collapsing;

    await h.core.toggleVideo();
    h.player.clearSent();
    h.player.ready();

    expect(h.player.sent[0]).toMatchObject({
      type: 'load',
      lessonId,
      startAt: 61,
      autoplay: false,
    });
  });

  it('collapses after 1 s with what FollowAlong knows when the page does not answer', async () => {
    const h = await createHarness();
    await playingZoomed(h);

    const collapsing = h.core.toggleVideo();
    h.clock.advance(1000);
    await collapsing;

    expect(h.player.hidden).toBe(true);
    await h.core.toggleVideo();
    h.player.clearSent();
    h.player.ready();
    expect(h.player.sent[0]).toMatchObject({ type: 'load', lessonId, startAt: 42, autoplay: true });
  });

  it('is shown again by a Lesson the learner picks, in the same spot', async () => {
    const h = await createHarness();
    await movedPlaying(h);
    const collapsing = h.core.toggleVideo();
    h.clock.advance(1000);
    await collapsing;

    h.core.nextLesson();

    expect(h.player.hidden).toBe(false);
    expect(lastSpot(h)).toBe('bottomPanel');
  });

  it('tells the learner when a playback key is pressed, and sends nothing', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const collapsing = h.core.toggleVideo();
    h.clock.advance(1000);
    await collapsing;
    h.player.clearSent();

    h.core.playPause();

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages.at(-1)).toEqual({
      severity: 'info',
      text: "FollowAlong: the video is collapsed. Press Ctrl+' V to bring it back.",
    });
  });

  it('keeps an ended Lesson ended, so the next play starts it again without a Rewind', async () => {
    const h = await createHarness();
    h.config.set('resumeRewind', 5);
    await playingZoomed(h);
    h.player.emit({ type: 'timeUpdate', lessonId, position: 300, duration: 300 });
    h.player.emit({ type: 'ended', lessonId });
    const collapsing = h.core.toggleVideo();
    answerSnapshot(h, 300, false);
    await collapsing;
    await h.core.toggleVideo();
    h.player.ready();
    h.player.emit({ type: 'seeked', lessonId, startSeek: true });
    h.player.clearSent();

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'play' }]);
  });

  it('is restored by Move video to…, in the spot the learner picks', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const collapsing = h.core.toggleVideo();
    h.clock.advance(1000);
    await collapsing;

    await h.core.moveVideo('secondarySidebar');

    expect(h.player.hidden).toBe(false);
    expect(lastSpot(h)).toBe('secondarySidebar');
  });

  it('collapses after a second press when the first waits for its snapshot, and restores after a third', async () => {
    const h = await createHarness();
    await playingZoomed(h);
    const shows = h.player.shown.length;

    const first = h.core.toggleVideo();
    const second = h.core.toggleVideo();
    answerSnapshot(h, 42, true);
    await Promise.all([first, second]);

    // Collapse, then undo: the video stays where it is.
    expect(h.player.hidden).toBe(false);
    expect(h.player.shown).toHaveLength(shows);
  });
});

describe('a move that was waiting when the Lesson changed', () => {
  it('does not carry the old Lesson having ended over to the next Lesson', async () => {
    const h = await createHarness();
    h.config.set('resumeRewind', 5);
    await playingZoomed(h);
    h.player.emit({ type: 'timeUpdate', lessonId, position: 300, duration: 300 });
    h.player.emit({ type: 'ended', lessonId });
    const moving = h.core.moveVideo('bottomPanel');
    answerSnapshot(h, 300, false);
    await moving;

    // The page in the bottom panel is still starting when the learner picks another Lesson.
    h.core.nextLesson();
    h.player.ready();
    h.player.emit({ type: 'timeUpdate', lessonId: '02 Next.webm', position: 20, duration: 300 });
    h.player.clearSent();

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'seekBy', seconds: -5 }, { type: 'play' }]);
  });
});
