import { describe, expect, it } from 'vitest';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** A Course with one Lesson, open in a player that is ready; the load is already sent. */
async function openLesson(h: Harness): Promise<void> {
  const course = await h.folder('course', { [lessonId]: 'video' });
  await h.core.openCourse(course);
  h.player.ready();
}

/** What a step command sends the player. */
function pressStep(
  h: Harness,
  size: 'short' | 'long',
  direction: 'back' | 'forward',
): PlayerCommand[] {
  const before = h.player.sent.length;
  h.core.seekStep(size, direction);
  return h.player.sent.slice(before);
}

describe('seek step commands', () => {
  it('steps forward by the short step, 5 s by default', async () => {
    const h = await createHarness();
    await openLesson(h);

    expect(pressStep(h, 'short', 'forward')).toEqual([{ type: 'seekBy', seconds: 5 }]);
  });

  it('steps back by the short step', async () => {
    const h = await createHarness();
    await openLesson(h);

    expect(pressStep(h, 'short', 'back')).toEqual([{ type: 'seekBy', seconds: -5 }]);
  });

  it('steps by the long step, 30 s by default, in both directions', async () => {
    const h = await createHarness();
    await openLesson(h);

    expect(pressStep(h, 'long', 'forward')).toEqual([{ type: 'seekBy', seconds: 30 }]);
    expect(pressStep(h, 'long', 'back')).toEqual([{ type: 'seekBy', seconds: -30 }]);
  });

  describe('step settings', () => {
    it('change the step at once, without a new Lesson', async () => {
      const h = await createHarness();
      await openLesson(h);
      expect(pressStep(h, 'short', 'forward')).toEqual([{ type: 'seekBy', seconds: 5 }]);

      h.config.set('shortStep', 10);
      h.config.set('longStep', 90);

      expect(pressStep(h, 'short', 'back')).toEqual([{ type: 'seekBy', seconds: -10 }]);
      expect(pressStep(h, 'long', 'forward')).toEqual([{ type: 'seekBy', seconds: 90 }]);
    });

    it('allow a fraction of a second', async () => {
      const h = await createHarness();
      await openLesson(h);
      h.config.set('shortStep', 2.5);

      expect(pressStep(h, 'short', 'forward')).toEqual([{ type: 'seekBy', seconds: 2.5 }]);
    });

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, '10', null])(
      'fall back to the default when the value is %j',
      async (value) => {
        const h = await createHarness();
        await openLesson(h);
        h.config.set('shortStep', value);
        h.config.set('longStep', value);

        expect(pressStep(h, 'short', 'forward')).toEqual([{ type: 'seekBy', seconds: 5 }]);
        expect(pressStep(h, 'long', 'forward')).toEqual([{ type: 'seekBy', seconds: 30 }]);
      },
    );
  });

  it('tells the learner when no Lesson is open, and sends nothing', async () => {
    const h = await createHarness();

    h.core.seekStep('short', 'forward');

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'FollowAlong: no Lesson is open. Open a Course first.' },
    ]);
  });

  it('sends nothing while the player page is still starting', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [lessonId]: 'video' });
    await h.core.openCourse(course);

    h.core.seekStep('long', 'back');

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });

  it('steps in the Lesson that is loaded, after a Lesson change', async () => {
    const h = await createHarness();
    await openLesson(h);
    const second = await h.folder('second', { 'other.webm': 'video' });
    await h.core.openCourse(second);
    h.player.ready();

    expect(pressStep(h, 'short', 'forward')).toEqual([{ type: 'seekBy', seconds: 5 }]);
  });
});
