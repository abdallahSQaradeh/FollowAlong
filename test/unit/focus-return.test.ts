import { describe, expect, it } from 'vitest';

import { createHarness } from './harness.js';

describe('focus return', () => {
  it('hands focus back to the Practice area when the learner interacts with the player', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    h.player.emit({ type: 'userInteracted' });

    expect(h.ui.focusReturns).toBe(1);
  });

  it('returns focus only on userInteracted, not on other player events', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    h.player.emit({ type: 'played', lessonId: '01 Intro.webm' });
    h.player.emit({ type: 'paused', lessonId: '01 Intro.webm', byUser: true });

    expect(h.ui.focusReturns).toBe(0);
  });

  it('hands focus back to the Practice area after a click on a status bar item', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    for (const command of ['playPause', 'seekBackShort', 'speedCycle'] as const) {
      h.core.statusBarClick(command);
    }

    expect(h.ui.focusReturns).toBe(3);
  });
});
