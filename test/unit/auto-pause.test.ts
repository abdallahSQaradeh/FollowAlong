import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DocumentEdit } from '../../src/core/auto-pause.js';
import type { StatusBarItemModel } from '../../src/core/status-bar.js';
import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness, type Tree } from './harness.js';

const lessonId = '01 Intro.webm';

/** The quiet period setting of `pauseAndResume`, in seconds. */
const resumeAfter = 'autoPauseResumeAfter';

/** A keystroke in the active editor's file: the edit auto-pause is for. */
const typing: DocumentEdit = {
  scheme: 'file',
  path: '/practice/app.js',
  inActiveEditor: true,
};

/**
 * A Course (one Lesson unless `tree` says otherwise), open in a ready player, with
 * `followalong.autoPause` as given.
 */
async function openLesson(
  h: Harness,
  mode: unknown,
  tree: Tree = { [lessonId]: 'video' },
): Promise<void> {
  h.config.set('autoPause', mode);
  const course = await h.folder('course', tree);
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
      // A focused Output panel is the active text editor, and its text grows on its own.
      ['the focused output panel', { scheme: 'output', inActiveEditor: true }],
      ['the user settings', { scheme: 'vscode-userdata', inActiveEditor: true }],
      ['the Source Control message box', { scheme: 'vscode-scm', inActiveEditor: false }],
      ['the focused Source Control message box', { scheme: 'vscode-scm', inActiveEditor: true }],
      ['a focused notebook cell', { scheme: 'vscode-notebook-cell', inActiveEditor: true }],
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

    it('leaves the learner’s own pause as theirs when they type before the player reports it', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      h.core.playPause();

      expect(edit(h)).toEqual([]);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('makes it the learner’s pause when they press pause after typing, before the player reports it', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.core.playPause();
      h.player.emit({ type: 'paused', lessonId, byUser: false });

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('makes it the learner’s pause when their click in the player paused it while they typed', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      // The click's pause is on its way from the player when the edit arrives.
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: true });

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('lets typing play through once the learner plays a Lesson it paused (story 102)', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });

      expect([...edit(h), ...edit(h)]).toEqual([]);
    });

    it('lets typing play through once the learner’s click plays a Lesson it paused', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      // A play the core did not ask for: the learner's click on the picture, or the native controls.
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([]);
    });

    it('plays through typing until the next pause of any kind, then pauses for typing again', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      expect(edit(h)).toEqual([{ type: 'pause' }]);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });
      expect(edit(h)).toEqual([]);

      // Any pause: here the learner's own, then they play again.
      h.core.playPause();
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('pauses for typing after the learner plays from a pause of their own', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });
      h.core.playPause();
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('re-arms when a pause the core did not ask for ends the play-through', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.player.emit({ type: 'played', lessonId });
      // Not the learner's: the player stopped by itself (a refused autoplay after a move, say).
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('re-arms when a pause the player reports ends the play-through', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.player.emit({ type: 'played', lessonId });
      // The learner's click on the picture pauses it, and a click plays it again.
      h.player.emit({ type: 'paused', lessonId, byUser: true });
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('ends the play-through at the Lesson’s end: the next Lesson pauses for typing', async () => {
      const h = await createHarness();
      const secondId = '02 Setup.webm';
      await openLesson(h, 'pause', { [lessonId]: 'video', [secondId]: 'video' });
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.player.emit({ type: 'played', lessonId });
      h.player.emit({ type: 'ended', lessonId });
      h.core.nextLesson();
      h.player.emit({ type: 'played', lessonId: secondId });

      expect(edit(h)).toEqual([{ type: 'pause' }]);
    });

    it('keeps the play-through when the player page reloads and the Lesson plays on', async () => {
      const h = await createHarness();
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.player.emit({ type: 'played', lessonId });
      h.player.ready();
      h.player.emit({ type: 'played', lessonId });

      expect(edit(h)).toEqual([]);
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

  describe('in `pause` mode, a new player page keeps the pause it caused', () => {
    /** The page tells what it shows when a move or collapse asks: paused at 1 s. */
    function answerSnapshot(h: Harness): void {
      h.player.emit({
        type: 'snapshot',
        snapshot: {
          rate: 1,
          zoom: { level: 1, left: 0, top: 0 },
          lesson: { lessonId, position: 1, playing: false },
        },
      });
    }

    /** A Lesson that typing paused in `pause` mode; the player has reported the pause. */
    async function pausedByTypingInPauseMode(h: Harness): Promise<void> {
      await openLesson(h, 'pause');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
    }

    it('when the video moves: “Paused (typing)” stays, and the learner’s play then plays through', async () => {
      const h = await createHarness();
      await pausedByTypingInPauseMode(h);
      const moving = h.core.moveVideo('bottomPanel');
      answerSnapshot(h);
      await moving;
      h.player.ready();

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: 'Paused (typing)' });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });
      expect(edit(h)).toEqual([]);
    });

    it('when the player page reloads: “Paused (typing)” stays, and the learner’s click then plays through', async () => {
      const h = await createHarness();
      await pausedByTypingInPauseMode(h);
      h.player.ready();

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: 'Paused (typing)' });
      h.player.emit({ type: 'played', lessonId });
      expect(edit(h)).toEqual([]);
    });

    it('when the video collapses and comes back: “Paused (typing)” stays, and the learner’s play then plays through', async () => {
      const h = await createHarness();
      await pausedByTypingInPauseMode(h);
      const collapsing = h.core.toggleVideo();
      answerSnapshot(h);
      await collapsing;
      expect(playPauseItem(h)).toMatchObject({ text: 'Paused (typing)' });
      await h.core.toggleVideo();
      h.player.ready();

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: 'Paused (typing)' });
      h.core.playPause();
      h.player.emit({ type: 'played', lessonId });
      expect(edit(h)).toEqual([]);
    });

    it('never resumes into the new page when the learner then switches to `pauseAndResume`', async () => {
      const h = await createHarness();
      await pausedByTypingInPauseMode(h);
      h.player.ready();
      h.config.set('autoPause', 'pauseAndResume');

      h.player.clearSent();
      h.clock.advance(10_000);

      expect(h.player.sent).not.toContainEqual({ type: 'play' });
      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });
  });

  describe('a Lesson end or change cancels it', () => {
    const secondId = '02 Setup.webm';

    /** A Course with two Lessons; auto-pause has paused the first one. */
    async function firstPausedByTyping(h: Harness): Promise<void> {
      await openLesson(h, 'pause', { [lessonId]: 'video', [secondId]: 'video' });
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

describe('pause and resume after a quiet period', () => {
  /** A playing Lesson that typing paused with `pauseAndResume`; the player has reported the pause. */
  async function pausedByTyping(h: Harness): Promise<void> {
    await openLesson(h, 'pauseAndResume');
    h.player.emit({ type: 'played', lessonId });
    expect(edit(h)).toEqual([{ type: 'pause' }]);
    h.player.emit({ type: 'paused', lessonId, byUser: false });
  }

  /** What the core sends the player while the fake clock moves on by `ms`. */
  function after(h: Harness, ms: number): PlayerCommand[] {
    const before = h.player.sent.length;
    h.clock.advance(ms);
    return h.player.sent.slice(before);
  }

  it('resumes the Lesson 2 s after the last edit by default', async () => {
    const h = await createHarness();
    await pausedByTyping(h);

    expect(after(h, 1999)).toEqual([]);
    expect(after(h, 1)).toEqual([{ type: 'play' }]);
  });

  describe('a pause of the learner’s own is never resumed (story 101)', () => {
    it('when they press pause before the player reported the auto-pause', async () => {
      const h = await createHarness();
      await openLesson(h, 'pauseAndResume');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.core.playPause();
      h.player.emit({ type: 'paused', lessonId, byUser: false });

      expect(after(h, 10_000)).toEqual([]);
      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('when their click in the player paused it while they typed', async () => {
      const h = await createHarness();
      await openLesson(h, 'pauseAndResume');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: true });

      expect(after(h, 10_000)).toEqual([]);
    });

    it('when they type on after their own pause', async () => {
      const h = await createHarness();
      await openLesson(h, 'pauseAndResume');
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: true });
      edit(h);

      expect(after(h, 10_000)).toEqual([]);
    });
  });

  it('pauses again for an edit after it resumed the Lesson: its own play is not the learner’s', async () => {
    const h = await createHarness();
    await pausedByTyping(h);
    expect(after(h, 2000)).toEqual([{ type: 'play' }]);
    h.player.emit({ type: 'played', lessonId });

    expect(edit(h)).toEqual([{ type: 'pause' }]);
  });

  it('leaves the Lesson paused when the learner switches to `pause` during the quiet period', async () => {
    const h = await createHarness();
    await pausedByTyping(h);
    h.clock.advance(500);
    h.config.set('autoPause', 'pause');

    expect(after(h, 10_000)).toEqual([]);
    expect(playPauseItem(h)).toMatchObject({ text: 'Paused (typing)' });
  });

  it('waits the quiet period the learner set', async () => {
    const h = await createHarness();
    h.config.set(resumeAfter, 0.5);
    await pausedByTyping(h);

    expect(after(h, 499)).toEqual([]);
    expect(after(h, 1)).toEqual([{ type: 'play' }]);
  });

  it('never rewinds, even with resume-with-rewind set (story 103)', async () => {
    const h = await createHarness();
    h.config.set('resumeRewind', 3);
    await pausedByTyping(h);

    expect(after(h, 2000)).toEqual([{ type: 'play' }]);
  });

  it('waits 2 s when the quiet period setting is not a number above 0', async () => {
    const h = await createHarness();
    h.config.set(resumeAfter, 0);
    await pausedByTyping(h);

    expect(after(h, 1999)).toEqual([]);
    expect(after(h, 1)).toEqual([{ type: 'play' }]);
  });

  describe('only the Lesson it paused, in the page that holds it', () => {
    const secondId = '02 Setup.webm';

    it('never resumes a Lesson that ended', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      h.player.emit({ type: 'ended', lessonId });

      expect(after(h, 10_000)).toEqual([]);
    });

    it('never resumes a Lesson the learner left', async () => {
      const h = await createHarness();
      await openLesson(h, 'pauseAndResume', { [lessonId]: 'video', [secondId]: 'video' });
      h.player.emit({ type: 'played', lessonId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId, byUser: false });
      h.core.nextLesson();

      expect(after(h, 10_000)).toEqual([]);
    });

    it('never resumes once the learner turns auto-pause off', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      h.config.set('autoPause', 'off');

      expect(after(h, 10_000)).toEqual([]);
    });

    it('ignores a late pause of the learner’s from an earlier load of the Lesson', async () => {
      const h = await createHarness();
      await openLesson(h, 'pauseAndResume', { [lessonId]: 'video', [secondId]: 'video' });
      h.core.nextLesson();
      h.player.emit({ type: 'played', lessonId: secondId });
      edit(h);
      h.player.emit({ type: 'paused', lessonId: secondId, byUser: false });
      // The `load` of the first Lesson was load 1; the page's click on it comes in late.
      h.player.emit({ type: 'paused', lessonId: secondId, loadId: 1, byUser: true });

      expect(playPauseItem(h)).toMatchObject({ text: 'Paused (typing)' });
      expect(after(h, 2000)).toEqual([{ type: 'play' }]);
    });

    it('drops the pause when the video moves, and leaves the Lesson paused', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      const moving = h.core.moveVideo('bottomPanel');
      h.player.emit({
        type: 'snapshot',
        snapshot: {
          rate: 1,
          zoom: { level: 1, left: 0, top: 0 },
          lesson: { lessonId, position: 1, playing: false },
        },
      });
      await moving;

      expect(after(h, 10_000)).toEqual([]);
      h.player.ready();
      expect(after(h, 10_000)).not.toContainEqual({ type: 'play' });
      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('drops the pause when the learner collapses the video, and never resumes it', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      const collapsing = h.core.toggleVideo();
      h.player.emit({
        type: 'snapshot',
        snapshot: {
          rate: 1,
          zoom: { level: 1, left: 0, top: 0 },
          lesson: { lessonId, position: 1, playing: false },
        },
      });
      await collapsing;

      expect(after(h, 10_000)).toEqual([]);
      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
      await h.core.toggleVideo();
      h.player.ready();
      expect(after(h, 10_000)).not.toContainEqual({ type: 'play' });
    });

    it('drops the pause when the moved page is ready before the quiet period ends', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      const moving = h.core.moveVideo('bottomPanel');
      h.player.emit({
        type: 'snapshot',
        snapshot: {
          rate: 1,
          zoom: { level: 1, left: 0, top: 0 },
          lesson: { lessonId, position: 1, playing: false },
        },
      });
      await moving;
      h.player.ready();

      expect(after(h, 10_000)).not.toContainEqual({ type: 'play' });
      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });

    it('never resumes while a move waits for the page to say what it shows', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      h.clock.advance(1500);
      const moving = h.core.moveVideo('bottomPanel');

      expect(after(h, 500)).toEqual([]);
      h.player.emit({
        type: 'snapshot',
        snapshot: {
          rate: 1,
          zoom: { level: 1, left: 0, top: 0 },
          lesson: { lessonId, position: 1, playing: false },
        },
      });
      await moving;
      h.player.ready();
      expect(after(h, 10_000)).not.toContainEqual({ type: 'play' });
    });

    it('drops the pause when the player page reloads', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      h.player.ready();

      expect(after(h, 10_000)).not.toContainEqual({ type: 'play' });
      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
    });
  });

  describe('when VS Code refuses its play', () => {
    it('ends the auto-pause and tells the learner once to press play', async () => {
      const h = await createHarness();
      await pausedByTyping(h);
      expect(after(h, 2000)).toEqual([{ type: 'play' }]);
      h.player.emit({ type: 'paused', lessonId, byUser: false });

      expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
      expect(h.ui.messages).toEqual([
        {
          severity: 'info',
          text: 'VS Code did not let “Intro” start by itself. Press play in the player to start it.',
        },
      ]);
      edit(h);
      expect(after(h, 10_000)).toEqual([]);
    });
  });

  it('starts the quiet period when the learner switches from `pause` during an auto-pause', async () => {
    const h = await createHarness();
    await openLesson(h, 'pause');
    h.player.emit({ type: 'played', lessonId });
    edit(h);
    h.player.emit({ type: 'paused', lessonId, byUser: false });
    h.config.set('autoPause', 'pauseAndResume');

    expect(after(h, 2000)).toEqual([{ type: 'play' }]);
  });

  it('lets typing play through when the learner plays during the quiet period', async () => {
    const h = await createHarness();
    await pausedByTyping(h);
    h.core.playPause();
    h.player.emit({ type: 'played', lessonId });

    expect(edit(h)).toEqual([]);
    expect(after(h, 10_000)).toEqual([]);
  });

  it('leaves the learner’s play to play through when it is on its way as the quiet period ends', async () => {
    const h = await createHarness();
    await pausedByTyping(h);
    h.clock.advance(1500);
    h.core.playPause();

    expect(after(h, 1000)).toEqual([]);
    h.player.emit({ type: 'played', lessonId });
    expect(edit(h)).toEqual([]);
  });

  it('leaves a plain pause when the player has not reported the pause by the end of the quiet period', async () => {
    const h = await createHarness();
    await openLesson(h, 'pauseAndResume');
    h.player.emit({ type: 'played', lessonId });
    edit(h);

    expect(after(h, 2000)).toEqual([]);
    h.player.emit({ type: 'paused', lessonId, byUser: false });
    expect(playPauseItem(h)).toMatchObject({ icon: 'play', text: '' });
  });

  it('counts a changed quiet period from the next edit, and keeps the pause it holds', async () => {
    const h = await createHarness();
    await pausedByTyping(h);
    h.clock.advance(500);
    h.config.set(resumeAfter, 5);

    expect(playPauseItem(h)).toMatchObject({ text: 'Paused (typing)' });
    expect(after(h, 1500)).toEqual([{ type: 'play' }]);
    h.player.emit({ type: 'played', lessonId });
    edit(h);
    h.player.emit({ type: 'paused', lessonId, byUser: false });
    expect(after(h, 4999)).toEqual([]);
    expect(after(h, 1)).toEqual([{ type: 'play' }]);
  });

  it('starts the quiet period again with every edit', async () => {
    const h = await createHarness();
    await pausedByTyping(h);
    h.clock.advance(1500);

    expect(edit(h)).toEqual([]);
    expect(after(h, 1999)).toEqual([]);
    expect(after(h, 1)).toEqual([{ type: 'play' }]);
  });
});
