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
});
