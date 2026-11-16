import { join } from 'node:path';

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

  it('pauses for an edit in an untitled document in the active editor', async () => {
    const h = await createHarness();
    await openLesson(h, 'pause');
    h.player.emit({ type: 'played', lessonId });

    expect(edit(h, { scheme: 'untitled', inActiveEditor: true })).toEqual([{ type: 'pause' }]);
  });

  describe('edits that are not the learner typing in the active editor', () => {
    const notTyping: readonly [string, DocumentEdit][] = [
      [
        'a file open in another editor',
        { scheme: 'file', path: '/practice/other.js', inActiveEditor: false },
      ],
      ['the output panel', { scheme: 'output', inActiveEditor: false }],
      ['the user settings', { scheme: 'vscode-userdata', inActiveEditor: true }],
      ['the Source Control message box', { scheme: 'vscode-scm', inActiveEditor: false }],
    ];

    for (const [where, documentEdit] of notTyping) {
      it(`does not pause for an edit in ${where}`, async () => {
        const h = await createHarness();
        await openLesson(h, 'pause');
        h.player.emit({ type: 'played', lessonId });

        expect(edit(h, documentEdit)).toEqual([]);
      });
    }
  });

  describe('FollowAlong’s own edits', () => {
    // FollowAlong never types into an editor. It writes its Course data to disk, and VS Code then
    // reloads a copy the learner has open, which VS Code reports as an edit of that document.
    it('does not pause when FollowAlong rewrites Course data the learner has open', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      const progressFile = join(h.root, 'course', '.followalong', 'progress.json');

      expect(edit(h, { scheme: 'file', path: progressFile, inActiveEditor: true })).toEqual([]);
    });

    it('does not pause when FollowAlong rewrites a file in its own storage', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      const fallbackFile = join(h.storage.folder, 'courses', 'abc', 'progress.json');

      expect(edit(h, { scheme: 'file', path: fallbackFile, inActiveEditor: true })).toEqual([]);
    });
  });

  describe('when it acts', () => {
    it('does nothing with auto-pause off', async () => {
      const h = await createHarness();
      await openLesson(h, 'off');
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([]);
    });

    it('is off unless the learner turns it on', async () => {
      const h = await createHarness();
      await openLesson(h, undefined);
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([]);
    });

    it('treats a setting it does not know as off', async () => {
      const h = await createHarness();
      await openLesson(h, 'Pause');
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([]);
    });

    it('does nothing while the Lesson is paused', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      h.player.emit({ type: 'paused', lessonId, byUser: true });

      expect(edit(h)).toEqual([]);
    });

    it('does nothing after the Lesson ended', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      h.player.emit({ type: 'ended', lessonId });

      expect(edit(h)).toEqual([]);
    });

    it('pauses once for a burst of keystrokes before the player reports the pause', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });

      expect([...edit(h), ...edit(h), ...edit(h)]).toEqual([{ type: 'pause' }]);
    });

    it('pauses again for the first edit after the learner resumed the Lesson', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('acts from the moment the learner turns it on, mid-Lesson', async () => {
      const h = await createHarness();
      await openLesson(h, 'off');
      h.player.emit({ type: 'played', lessonId });
      h.config.set('autoPause', 'pause');

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('stops from the moment the learner turns it off, mid-Lesson', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      h.config.set('autoPause', 'off');

      expect(edit(h)).toEqual([]);
    });
  });
});
