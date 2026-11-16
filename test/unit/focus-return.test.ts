import { describe, expect, it } from 'vitest';

import { createHarness } from './harness.js';

describe('focus return', () => {
  it('hands focus back to the code when the learner interacts with the player', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    h.player.emit({ type: 'userInteracted' });

    expect(h.ui.focusReturns).toBe(1);
  });

  it('keeps focus where it is while the learner does not touch the player', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    h.player.emit({ type: 'played', lessonId: '01 Intro.webm' });
    h.player.emit({ type: 'paused', lessonId: '01 Intro.webm', byUser: true });

    expect(h.ui.focusReturns).toBe(0);
  });
});
