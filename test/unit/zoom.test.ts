import { describe, expect, it } from 'vitest';

import type { StatusBarItemModel } from '../../src/core/status-bar.js';
import { createHarness, type Harness } from './harness.js';

/** A Course with one Lesson, open in a player that is ready; the load is already sent. */
async function openLesson(h: Harness): Promise<void> {
  const course = await h.folder('course', { '01 Intro.webm': 'video' });
  await h.core.openCourse(course);
  h.player.ready();
}

function zoomItem(h: Harness): StatusBarItemModel | undefined {
  return h.ui.statusBar.items.find((item) => item.id === 'zoom');
}

describe('the status bar zoom item', () => {
  it('is not shown at 1×', async () => {
    const h = await createHarness();
    await openLesson(h);

    h.player.emit({ type: 'zoomChanged', level: 1 });

    expect(zoomItem(h)).toBeUndefined();
  });

  it('shows the level while zoomed, after the back item, and goes at 1× again', async () => {
    const h = await createHarness();
    await openLesson(h);

    h.player.emit({ type: 'zoomChanged', level: 2.44140625 });

    expect(h.ui.statusBar.items.map((item) => item.id)).toEqual([
      'playPause',
      'time',
      'speed',
      'back',
      'zoom',
    ]);
    expect(zoomItem(h)).toMatchObject({ icon: 'zoom', text: '2.4×', command: 'zoomReset' });

    h.player.emit({ type: 'zoomChanged', level: 1.25 });
    expect(zoomItem(h)?.text).toBe('1.3×');

    h.player.emit({ type: 'zoomChanged', level: 1 });
    expect(zoomItem(h)).toBeUndefined();
  });

  it('resets the zoom when clicked, and hands focus back', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'zoomChanged', level: 4 });
    h.player.clearSent();

    h.core.statusBarClick('zoomReset');

    expect(h.player.sent).toEqual([{ type: 'zoom', action: 'reset' }]);
    expect(h.ui.focusReturns).toBe(1);
    // The player says when the picture is whole again.
    h.player.emit({ type: 'zoomChanged', level: 1 });
    expect(zoomItem(h)).toBeUndefined();
  });

  it('stays while another Lesson of the Course loads: zoom belongs to the player', async () => {
    const h = await createHarness();
    const course = await h.folder('two', { '01 A.webm': 'video', '02 B.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.emit({ type: 'zoomChanged', level: 4 });

    h.core.playLesson('02 B.webm');

    expect(zoomItem(h)?.text).toBe('4×');
  });

  it('goes with a new player page, which starts at 1× until it reports its zoom', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'zoomChanged', level: 4 });

    h.player.ready();
    expect(zoomItem(h)).toBeUndefined();

    // A page that kept its zoom in the webview state reports it after `ready`.
    h.player.emit({ type: 'zoomChanged', level: 4 });
    expect(zoomItem(h)?.text).toBe('4×');
  });

  it('goes with the player when the learner closes it', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'zoomChanged', level: 4 });

    h.player.close();
    await h.core.openCourse(await h.folder('other', { '01 Other.webm': 'video' }));

    expect(zoomItem(h)).toBeUndefined();
  });
});
