import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DocumentEdit } from '../../src/core/auto-pause.js';
import type { StatusBarItemModel } from '../../src/core/status-bar.js';
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

/** The play/pause status bar item, as the learner sees it now. */
function playPauseItem(h: Harness): StatusBarItemModel | undefined {
  return h.ui.statusBar.items.find((item) => item.id === 'playPause');
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
    it('sends nothing and says nothing while no Lesson is loaded', async () => {
      const h = await createHarness();
      h.config.set('autoPause', 'pause');

      expect(edit(h)).toEqual([]);
      expect(h.ui.messages).toEqual([]);
    });

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

  describe('the status bar marker', () => {
    it('shows on the play/pause item while auto-pause is on, its tooltip naming the mode', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');

      expect(playPauseItem(h)).toMatchObject({
        icon: 'play',
        marker: 'autoPause',
        tooltip: 'Play the Lesson · Auto-pause: pause',
      });
      h.player.emit({ type: 'played', lessonId });
      expect(playPauseItem(h)).toMatchObject({
        icon: 'pause',
        marker: 'autoPause',
        tooltip: 'Pause the Lesson · Auto-pause: pause',
      });
    });

    it('names the pause-and-resume mode', async () => {
      const h = await createHarness();
      await openLesson(h, 'pauseAndResume');

      expect(playPauseItem(h)).toMatchObject({
        marker: 'autoPause',
        tooltip: 'Play the Lesson · Auto-pause: pause and resume',
      });
    });

    it('does not show while auto-pause is off', async () => {
      const h = await createHarness();
      await openLesson(h, 'off');

      expect(playPauseItem(h)).toEqual({
        id: 'playPause',
        icon: 'play',
        text: '',
        tooltip: 'Play the Lesson',
        command: 'playPause',
      });
    });

    it('follows the setting at once, mid-Lesson', async () => {
      const h = await createHarness();
      await openLesson(h, 'off');

      h.config.set('autoPause', 'pause');
      expect(playPauseItem(h)).toMatchObject({ marker: 'autoPause' });

      h.config.set('autoPause', 'off');
      expect(playPauseItem(h)).not.toHaveProperty('marker');
    });
  });

  describe('“Paused (typing)”', () => {
    /** A Lesson that auto-pause paused: the player has reported the pause it was sent. */
    async function pausedByTyping(h: Harness): Promise<void> {
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
    }

    it('shows on the play/pause item once auto-pause has paused the Lesson', async () => {
      const h = await createHarness();
      await pausedByTyping(h);

      expect(playPauseItem(h)).toMatchObject({
        icon: 'play',
        marker: 'autoPause',
        text: 'Paused (typing)',
      });
    });

    it('goes when the Lesson plays again', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });

      expect(playPauseItem(h)).toMatchObject({ icon: 'pause', text: '' });
    });

    it('does not show for a pause of the learner’s own', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      h.player.emit({ type: 'paused', lessonId, byUser: true });

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('goes when the learner turns auto-pause off', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      h.config.set('autoPause', 'off');

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });
  });

  describe('a Lesson end or change cancels it', () => {
    const secondId = '02 Setup.webm';

    /** A Course with two Lessons; auto-pause has paused the first one. */
    async function firstPausedByTyping(h: Harness): Promise<void> {
      h.config.set('autoPause', 'pause');
      const course = await h.folder('course', { [lessonId]: 'video', [secondId]: 'video' });
      await h.core.openCourse(course);
      h.player.ready();
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      expect(playPauseItem(h)).toMatchObject({ text: 'Paused (typing)' });
    }

    it('does not carry “Paused (typing)” to the next Lesson', async () => {
      const h = await createHarness();
      await firstPausedByTyping(h);

      h.core.nextLesson();

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', marker: 'autoPause', text: '' });
    });

    it('stays armed for the next Lesson: an edit while it plays pauses it', async () => {
      const h = await createHarness();
      await firstPausedByTyping(h);
      h.core.nextLesson();
      h.player.emit({ type: 'played', lessonId: secondId });

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('drops “Paused (typing)” when the learner steps to the Lesson’s end', async () => {
      const h = await createHarness();
      await firstPausedByTyping(h);

      h.player.emit({ type: 'ended', lessonId });

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('drops “Paused (typing)” when the learner opens another Course', async () => {
      const h = await createHarness();
      await firstPausedByTyping(h);
      const other = await h.folder('other', { 'other.webm': 'video' });

      await h.core.openCourse(other);

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });
  });
});
