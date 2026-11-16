import { describe, expect, it } from 'vitest';

import type { DocumentEdit } from '../../src/core/auto-pause.js';
import type { StatusBarItemModel } from '../../src/core/status-bar.js';
import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** A keystroke in the active editor's file. */
const typing: DocumentEdit = {
  scheme: 'file',
  path: '/practice/app.js',
  inActiveEditor: true,
};

/** A Course with one Lesson, open in a ready player, with `followalong.autoPause` as given. */
async function openLesson(h: Harness, mode: unknown): Promise<void> {
  if (mode !== undefined) {
    h.config.set('autoPause', mode);
  }
  const course = await h.folder('course', { [lessonId]: 'video' });
  await h.core.openCourse(course);
  h.player.ready();
}

/** The play/pause status bar item, as the learner sees it now. */
function playPauseItem(h: Harness): StatusBarItemModel | undefined {
  return h.ui.statusBar.items.find((item) => item.id === 'playPause');
}

describe('Toggle Auto-pause', () => {
  it('turns auto-pause on as `pause` when no mode was ever on, and the marker follows', async () => {
    const h = await createHarness();
    await openLesson(h, undefined);
    expect(playPauseItem(h)).not.toHaveProperty('marker');

    await h.core.toggleAutoPause();

    expect(h.config.get('autoPause')).toBe('pause');
    expect(playPauseItem(h)).toMatchObject({ marker: 'autoPause' });
    h.player.emit({ type: 'played', lessonId });
    h.player.clearSent();
    h.core.documentEdited(typing);
    expect(h.player.sent).toEqual([{ type: 'pause' }]);
  });

  it('turns it off, and back on in the mode that was on, with the marker following', async () => {
    const h = await createHarness();
    await openLesson(h, 'pauseAndResume');

    await h.core.toggleAutoPause();
    expect(h.config.get('autoPause')).toBe('off');
    expect(playPauseItem(h)).not.toHaveProperty('marker');

    await h.core.toggleAutoPause();
    expect(h.config.get('autoPause')).toBe('pauseAndResume');
    expect(playPauseItem(h)).toMatchObject({ marker: 'autoPause' });
  });

  it('remembers the mode the learner last set by hand in the settings', async () => {
    const h = await createHarness();
    await openLesson(h, 'pause');
    h.config.set('autoPause', 'pauseAndResume');
    h.config.set('autoPause', 'off');

    await h.core.toggleAutoPause();

    expect(h.config.get('autoPause')).toBe('pauseAndResume');
  });

  it('remembers the mode a window opened with, when the learner turns it off by hand', async () => {
    const h = await createHarness();
    h.config.set('autoPause', 'pauseAndResume');
    h.restart();
    h.config.set('autoPause', 'off');

    await h.core.toggleAutoPause();

    expect(h.config.get('autoPause')).toBe('pauseAndResume');
  });

  it('remembers the mode across a restart of VS Code', async () => {
    const h = await createHarness();
    await openLesson(h, 'pauseAndResume');
    await h.core.toggleAutoPause();
    h.restart();

    await h.core.toggleAutoPause();

    expect(h.config.get('autoPause')).toBe('pauseAndResume');
  });

  it('cancels the quiet period when it turns auto-pause off mid auto-pause', async () => {
    const h = await createHarness();
    await openLesson(h, 'pauseAndResume');
    h.player.emit({ type: 'played', lessonId });
    h.core.documentEdited(typing);
    h.player.emit({ type: 'paused', lessonId, byUser: false });
    expect(playPauseItem(h)).toMatchObject({ text: 'Paused (typing)' });

    h.clock.advance(1000);
    await h.core.toggleAutoPause();
    h.player.clearSent();
    h.clock.advance(10_000);

    expect(h.player.sent).not.toContainEqual({ type: 'play' });
    expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    expect(playPauseItem(h)).not.toHaveProperty('marker');
  });

  it('says what it did when no Lesson is loaded, where the marker is not shown', async () => {
    const h = await createHarness();

    await h.core.toggleAutoPause();
    expect(h.config.get('autoPause')).toBe('pause');
    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'FollowAlong: auto-pause is on (pause).' },
    ]);

    await h.core.toggleAutoPause();
    expect(h.ui.messages.at(-1)).toEqual({
      severity: 'info',
      text: 'FollowAlong: auto-pause is off.',
    });
  });

  it('says nothing while a Lesson is loaded: the marker shows it', async () => {
    const h = await createHarness();
    await openLesson(h, undefined);

    await h.core.toggleAutoPause();

    expect(h.ui.messages).toEqual([]);
  });

  it('ignores a value that is no mode: it is off, and the last real mode comes back', async () => {
    const h = await createHarness();
    await openLesson(h, 'pauseAndResume');
    h.config.set('autoPause', 'Pause');

    await h.core.toggleAutoPause();

    expect(h.config.get('autoPause')).toBe('pauseAndResume');
  });
});
