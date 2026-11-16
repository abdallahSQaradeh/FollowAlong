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

/** What a speed command sends the player. */
function pressSpeed(h: Harness, direction: 'up' | 'down'): PlayerCommand[] {
  const before = h.player.sent.length;
  h.core.speedStep(direction);
  return h.player.sent.slice(before);
}

/** The rate the learner would end on after pressing `direction` `count` times, one press at a time. */
function pressRates(h: Harness, direction: 'up' | 'down', count: number): unknown[] {
  return Array.from({ length: count }, () => {
    const [command] = pressSpeed(h, direction);
    return command?.type === 'setRate' ? command.rate : command;
  });
}

describe('speed commands', () => {
  it('step up the ladder from 1×, one rung per press, and stop at 2×', async () => {
    const h = await createHarness();
    await openLesson(h);

    expect(pressRates(h, 'up', 5)).toEqual([1.25, 1.5, 2, 2, 2]);
  });

  it('step down the ladder from 1×, one rung per press, and stop at 0.75×', async () => {
    const h = await createHarness();
    await openLesson(h);

    expect(pressRates(h, 'down', 3)).toEqual([0.75, 0.75, 0.75]);
  });

  it('go up and down over the same rungs', async () => {
    const h = await createHarness();
    await openLesson(h);

    expect([
      ...pressRates(h, 'up', 3),
      ...pressRates(h, 'down', 3),
      ...pressRates(h, 'down', 1),
    ]).toEqual([1.25, 1.5, 2, 1.5, 1.25, 1, 0.75]);
  });

  it('follow the rate the player reports, such as one picked in the video’s own menu', async () => {
    const h = await createHarness();
    await openLesson(h);

    h.player.emit({ type: 'rateChanged', lessonId, rate: 1.5 });

    expect(pressSpeed(h, 'up')).toEqual([{ type: 'setRate', rate: 2 }]);
    h.player.emit({ type: 'rateChanged', lessonId, rate: 0.75 });
    expect(pressSpeed(h, 'up')).toEqual([{ type: 'setRate', rate: 1 }]);
  });

  it('step to the next rung when the rate is between two rungs', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'rateChanged', lessonId, rate: 1.1 });

    expect(pressSpeed(h, 'up')).toEqual([{ type: 'setRate', rate: 1.25 }]);
    h.player.emit({ type: 'rateChanged', lessonId, rate: 1.1 });
    expect(pressSpeed(h, 'down')).toEqual([{ type: 'setRate', rate: 1 }]);
  });

  it('come back onto the ladder from a rate beyond its ends', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'rateChanged', lessonId, rate: 3 });

    expect(pressSpeed(h, 'up')).toEqual([{ type: 'setRate', rate: 2 }]);
    h.player.emit({ type: 'rateChanged', lessonId, rate: 0.5 });
    expect(pressSpeed(h, 'down')).toEqual([{ type: 'setRate', rate: 0.75 }]);
  });

  it('keep the rate when the next Lesson is played', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [lessonId]: 'video', '02 Next.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    pressSpeed(h, 'up');
    h.core.playLesson('02 Next.webm');

    expect(pressSpeed(h, 'up')).toEqual([{ type: 'setRate', rate: 1.5 }]);
  });

  it('start from 1× again when the player page starts over', async () => {
    const h = await createHarness();
    await openLesson(h);
    pressSpeed(h, 'up');
    h.player.ready();

    expect(pressSpeed(h, 'up')).toEqual([{ type: 'setRate', rate: 1.25 }]);
  });

  it('tell the learner when no Lesson is open, and send nothing', async () => {
    const h = await createHarness();

    h.core.speedStep('up');

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'FollowAlong: no Lesson is open. Open a Course first.' },
    ]);
  });

  it('send nothing while the player page is still starting', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [lessonId]: 'video' });
    await h.core.openCourse(course);

    h.core.speedStep('down');

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });
});
