import { describe, expect, it } from 'vitest';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** A Course with one Lesson, open in a player that is ready; the load is already sent. */
async function openLesson(h: Harness, name = 'course'): Promise<void> {
  const course = await h.folder(name, { [lessonId]: 'video' });
  await h.core.openCourse(course);
  h.player.ready();
}

/** What the play/pause command sends the player. */
function pressPlayPause(h: Harness): PlayerCommand[] {
  const before = h.player.sent.length;
  h.core.playPause();
  return h.player.sent.slice(before);
}

describe('play/pause command', () => {
  it('pauses a Lesson that is playing', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    const sent = pressPlayPause(h);

    expect(sent).toEqual([{ type: 'pause' }]);
  });

  it('plays a Lesson that the learner paused', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'paused', lessonId, byUser: true });
    const sent = pressPlayPause(h);

    expect(sent).toEqual([{ type: 'play' }]);
  });

  it('plays a Lesson that VS Code did not let start by itself', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'paused', lessonId, byUser: false });
    const sent = pressPlayPause(h);

    expect(sent).toEqual([{ type: 'play' }]);
  });

  it('plays a Lesson again after it ended', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'ended', lessonId });
    const sent = pressPlayPause(h);

    expect(sent).toEqual([{ type: 'play' }]);
  });

  it('plays, not pauses, the next Lesson that was loaded while the last one played', async () => {
    const h = await createHarness();
    await openLesson(h, 'first');
    h.player.emit({ type: 'played', lessonId });
    const second = await h.folder('second', { 'other.webm': 'video' });
    await h.core.openCourse(second);
    h.player.ready();
    const sent = pressPlayPause(h);

    expect(sent).toEqual([{ type: 'play' }]);
  });

  it('ignores what the player says about a Lesson that is no longer loaded', async () => {
    const h = await createHarness();
    await openLesson(h, 'first');
    const second = await h.folder('second', { 'other.webm': 'video' });
    await h.core.openCourse(second);
    h.player.ready();
    h.player.emit({ type: 'played', lessonId });
    const sent = pressPlayPause(h);

    expect(sent).toEqual([{ type: 'play' }]);
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

  describe('when VS Code refuses a play the command sent', () => {
    const pressPlayMessage = {
      severity: 'info',
      text: 'VS Code did not let “Intro” start by itself. Press play in the player to start it.',
    } as const;

    /** A Lesson whose autoplay VS Code refused; the learner has been told once. */
    async function refusedAutoplay(h: Harness): Promise<void> {
      await openLesson(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      expect(h.ui.messages).toEqual([pressPlayMessage]);
    }

    /** The learner presses the key and the player refuses the play. */
    function refusedKeypress(h: Harness): void {
      h.core.playPause();
      h.player.emit({ type: 'paused', lessonId, byUser: false });
    }

    it('says to press play in the player, also after the refused autoplay it already said it for', async () => {
      const h = await createHarness();
      await refusedAutoplay(h);

      refusedKeypress(h);

      expect(h.ui.messages).toEqual([pressPlayMessage, pressPlayMessage]);
    });

    it('says it once, not on every keypress, while the player keeps refusing', async () => {
      const h = await createHarness();
      await refusedAutoplay(h);

      for (let press = 0; press < 4; press += 1) {
        refusedKeypress(h);
      }

      expect(h.ui.messages).toEqual([pressPlayMessage, pressPlayMessage]);
    });

    it('says it again when the Lesson has played in between', async () => {
      const h = await createHarness();
      await refusedAutoplay(h);
      refusedKeypress(h);

      h.player.emit({ type: 'played', lessonId });
      h.player.emit({ type: 'paused', lessonId, byUser: true });
      refusedKeypress(h);

      expect(h.ui.messages).toEqual([pressPlayMessage, pressPlayMessage, pressPlayMessage]);
    });

    it('says it again for a Lesson loaded after the refusals', async () => {
      const h = await createHarness();
      await refusedAutoplay(h);
      refusedKeypress(h);
      const second = await h.folder('second', { 'other.webm': 'video' });
      await h.core.openCourse(second);
      h.player.ready();
      h.ui.messages.length = 0;

      h.player.emit({ type: 'paused', lessonId: 'other.webm', byUser: false });
      h.core.playPause();
      h.player.emit({ type: 'paused', lessonId: 'other.webm', byUser: false });

      expect(h.ui.messages.map((message) => message.text)).toEqual([
        'VS Code did not let “other” start by itself. Press play in the player to start it.',
        'VS Code did not let “other” start by itself. Press play in the player to start it.',
      ]);
    });

    it('says nothing when the play worked', async () => {
      const h = await createHarness();
      await refusedAutoplay(h);

      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });

      expect(h.ui.messages).toEqual([pressPlayMessage]);
    });

    it('says nothing about a pause the command itself asked for', async () => {
      const h = await createHarness();
      await openLesson(h);
      h.player.emit({ type: 'played', lessonId });

      h.core.playPause();
      h.player.emit({ type: 'paused', lessonId, byUser: false });

      expect(h.ui.messages).toEqual([]);
    });
  });
});
