import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** A Course with one Lesson, open in a player that is ready; the load is already sent. */
async function openLesson(h: Harness, name = 'course'): Promise<void> {
  const course = await h.folder(name, { [lessonId]: 'video' });
  await h.core.openCourse(course);
  h.player.ready();
}

describe('play/pause command', () => {
  it('pauses a Lesson that is playing', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    h.player.sent.length = 0;

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'pause' }]);
  });

  it('plays a Lesson that the learner paused', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'paused', lessonId, byUser: true });
    h.player.sent.length = 0;

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'play' }]);
  });

  it('plays a Lesson that VS Code did not let start by itself', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'paused', lessonId, byUser: false });
    h.player.sent.length = 0;

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'play' }]);
  });

  it('plays a Lesson again after it ended', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'ended', lessonId });
    h.player.sent.length = 0;

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'play' }]);
  });

  it('plays, not pauses, the next Lesson that was loaded while the last one played', async () => {
    const h = await createHarness();
    await openLesson(h, 'first');
    h.player.emit({ type: 'played', lessonId });
    const second = await h.folder('second', { 'other.webm': 'video' });
    await h.core.openCourse(second);
    h.player.ready();
    h.player.sent.length = 0;

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'play' }]);
  });

  it('ignores what the player says about a Lesson that is no longer loaded', async () => {
    const h = await createHarness();
    await openLesson(h, 'first');
    const second = await h.folder('second', { 'other.webm': 'video' });
    await h.core.openCourse(second);
    h.player.ready();
    h.player.emit({ type: 'played', lessonId });
    h.player.sent.length = 0;

    h.core.playPause();

    expect(h.player.sent).toEqual([{ type: 'play' }]);
  });

  it('tells the learner when no Lesson is open, and sends nothing', async () => {
    const h = await createHarness();

    h.core.playPause();

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'FollowAlong: no Lesson is open. Open a Course first.' },
    ]);
  });

  it('sends nothing while the player page is still starting; the Lesson autoplays when ready', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [lessonId]: 'video' });
    await h.core.openCourse(course);

    h.core.playPause();

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });
});
