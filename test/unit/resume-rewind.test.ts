import { describe, expect, it } from 'vitest';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** A Course with one Lesson, open in a ready player, played and then paused by the learner. */
async function openPausedLesson(h: Harness): Promise<void> {
  const course = await h.folder('course', { [lessonId]: 'video' });
  await h.core.openCourse(course);
  h.player.ready();
  h.player.emit({ type: 'played', lessonId });
  h.player.emit({ type: 'paused', lessonId, byUser: true });
}

function sentBy(h: Harness, press: () => void): PlayerCommand[] {
  const before = h.player.sent.length;
  press();
  return h.player.sent.slice(before);
}

describe('resume with rewind', () => {
  it('does not seek on a manual resume by default', async () => {
    const h = await createHarness();
    await openPausedLesson(h);

    expect(
      sentBy(h, () => {
        h.core.playPause();
      }),
    ).toEqual([{ type: 'play' }]);
  });

  it('seeks back by the setting, then plays, on a manual resume', async () => {
    const h = await createHarness();
    await openPausedLesson(h);
    h.config.set('resumeRewind', 3);

    expect(
      sentBy(h, () => {
        h.core.playPause();
      }),
    ).toEqual([{ type: 'seekBy', seconds: -3 }, { type: 'play' }]);
  });

  it('reads the setting on every press', async () => {
    const h = await createHarness();
    await openPausedLesson(h);
    h.config.set('resumeRewind', 3);
    h.config.set('resumeRewind', 7.5);

    expect(
      sentBy(h, () => {
        h.core.playPause();
      }),
    ).toEqual([{ type: 'seekBy', seconds: -7.5 }, { type: 'play' }]);
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY, '4', null])(
    'does not seek when the setting is %j',
    async (value) => {
      const h = await createHarness();
      await openPausedLesson(h);
      h.config.set('resumeRewind', value);

      expect(
        sentBy(h, () => {
          h.core.playPause();
        }),
      ).toEqual([{ type: 'play' }]);
    },
  );

  it('does not rewind when the learner pauses', async () => {
    const h = await createHarness();
    await openPausedLesson(h);
    h.config.set('resumeRewind', 3);
    h.player.emit({ type: 'played', lessonId });

    expect(
      sentBy(h, () => {
        h.core.playPause();
      }),
    ).toEqual([{ type: 'pause' }]);
  });

  it('does not rewind a Lesson that ended: play starts it again', async () => {
    const h = await createHarness();
    await openPausedLesson(h);
    h.config.set('resumeRewind', 3);
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'ended', lessonId });

    expect(
      sentBy(h, () => {
        h.core.playPause();
      }),
    ).toEqual([{ type: 'play' }]);
  });

  describe('the automatic resume path', () => {
    it('plays without a seek even when the setting is above 0', async () => {
      const h = await createHarness();
      await openPausedLesson(h);
      h.config.set('resumeRewind', 3);

      expect(
        sentBy(h, () => {
          h.core.resumeWithoutRewind();
        }),
      ).toEqual([{ type: 'play' }]);
    });

    it('does nothing while the Lesson is playing', async () => {
      const h = await createHarness();
      await openPausedLesson(h);
      h.player.emit({ type: 'played', lessonId });

      expect(
        sentBy(h, () => {
          h.core.resumeWithoutRewind();
        }),
      ).toEqual([]);
    });
  });

  describe('the player applies it to a click', () => {
    it('is told the setting once the page is ready, and not again with each Lesson', async () => {
      const h = await createHarness();
      h.config.set('resumeRewind', 4);
      const course = await h.folder('course', { [lessonId]: 'video', '02 Next.webm': 'video' });
      await h.core.openCourse(course);
      h.player.ready();

      expect(h.player.sent.map((command) => command.type)).toEqual(['load', 'setResumeRewind']);
      expect(h.player.sent[1]).toEqual({ type: 'setResumeRewind', seconds: 4 });

      h.player.clearSent();
      h.core.playLesson('02 Next.webm');
      expect(h.player.sent.map((command) => command.type)).toEqual(['load']);
    });

    it('is told again when the player page reloads', async () => {
      const h = await createHarness();
      h.config.set('resumeRewind', 4);
      const course = await h.folder('course', { [lessonId]: 'video' });
      await h.core.openCourse(course);
      h.player.ready();
      h.player.clearSent();

      h.player.ready();

      expect(h.player.sent).toContainEqual({ type: 'setResumeRewind', seconds: 4 });
    });

    it('says nothing while the setting is the default', async () => {
      const h = await createHarness();
      const course = await h.folder('course', { [lessonId]: 'video' });
      await h.core.openCourse(course);
      h.player.ready();

      expect(h.player.sent.map((command) => command.type)).toEqual(['load']);
    });

    it('is told when the setting changes', async () => {
      const h = await createHarness();
      await openPausedLesson(h);
      h.player.clearSent();

      h.config.set('resumeRewind', 6);

      expect(h.player.sent).toEqual([{ type: 'setResumeRewind', seconds: 6 }]);
    });

    it('is not told about other settings', async () => {
      const h = await createHarness();
      await openPausedLesson(h);
      h.player.clearSent();

      h.config.set('shortStep', 9);

      expect(h.player.sent).toEqual([]);
    });

    it('is told 0 for a bad value', async () => {
      const h = await createHarness();
      await openPausedLesson(h);
      h.config.set('resumeRewind', 5);
      h.player.clearSent();

      h.config.set('resumeRewind', -1);

      expect(h.player.sent).toEqual([{ type: 'setResumeRewind', seconds: 0 }]);
    });

    it('waits for the player page to be ready', async () => {
      const h = await createHarness();
      const course = await h.folder('course', { [lessonId]: 'video' });
      await h.core.openCourse(course);

      h.config.set('resumeRewind', 6);

      expect(h.player.sent).toEqual([]);
    });
  });
});
