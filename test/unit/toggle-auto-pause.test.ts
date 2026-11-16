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
});
