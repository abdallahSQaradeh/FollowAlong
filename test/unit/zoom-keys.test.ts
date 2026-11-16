import { describe, expect, it } from 'vitest';

import type { ZoomAction } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

/** A Course with one Lesson, open in a player that is ready; the load is already sent. */
async function openLesson(h: Harness): Promise<void> {
  const course = await h.folder('course', { '01 Intro.webm': 'video' });
  await h.core.openCourse(course);
  h.player.ready();
  h.player.clearSent();
}

describe('the zoom commands', () => {
  it.each<ZoomAction>(['areaMode', 'in', 'out', 'reset'])(
    'send the player one zoom %s message and leave focus where it is',
    async (action) => {
      const h = await createHarness();
      await openLesson(h);

      h.core.zoom(action);

      expect(h.player.sent).toEqual([{ type: 'zoom', action }]);
      // A key press never took focus from the editor or terminal: there is nothing to hand back.
      expect(h.ui.focusReturns).toBe(0);
    },
  );

  it('send nothing while no Lesson is loaded, and say so', async () => {
    const h = await createHarness();

    h.core.zoom('in');

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toHaveLength(1);
  });

  it('send nothing while the player is still starting', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.clearSent();

    h.core.zoom('out');

    expect(h.player.sent).toEqual([]);
  });
});
