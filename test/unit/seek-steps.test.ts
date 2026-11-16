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
  it('step forward by the short step, 5 s by default', async () => {
    const h = await createHarness();
    await openLesson(h);

    expect(pressStep(h, 'short', 'forward')).toEqual([{ type: 'seekBy', seconds: 5 }]);
  });
});
