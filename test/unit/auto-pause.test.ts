import { describe, expect, it } from 'vitest';

import type { DocumentEdit } from '../../src/core/auto-pause.js';
import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** A keystroke in the active editor's file: the edit auto-pause is for. */
const typing: DocumentEdit = {
  scheme: 'file',
  path: '/practice/app.js',
  inActiveEditor: true,
};

/** A Course with one Lesson, open in a ready player, with `followalong.autoPause` as given. */
async function openLesson(h: Harness, mode: unknown): Promise<void> {
  h.config.set('autoPause', mode);
  const course = await h.folder('course', { [lessonId]: 'video' });
  await h.core.openCourse(course);
  h.player.ready();
}

/** What the core sends the player for this edit. */
function edit(h: Harness, documentEdit: DocumentEdit = typing): PlayerCommand[] {
  const before = h.player.sent.length;
  h.core.documentEdited(documentEdit);
  return h.player.sent.slice(before);
}

describe('auto-pause while typing', () => {
  it('pauses a playing Lesson when the learner edits the active editor’s file', async () => {
    const h = await createHarness();
    await openLesson(h, 'pause');
    h.player.emit({ type: 'played', lessonId });

    expect(edit(h)).toEqual([{ type: 'pause' }]);
  });
});
