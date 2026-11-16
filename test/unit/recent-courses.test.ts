import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';
import { makeReadOnly } from './read-only.js';

/** The picker as the learner reads it: a separator as `── label`, an item as label and description. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) => {
    if (entry.kind === 'separator') {
      return `── ${entry.label}`;
    }
    return entry.description === undefined ? entry.label : `${entry.label} — ${entry.description}`;
  });
}

/** A Courses root holding one Course per name, and the Courses roots setting pointing at it. */
async function learning(h: Harness, names: readonly string[]): Promise<Record<string, string>> {
  const tree = Object.fromEntries(names.map((name) => [`${name}/01 Intro.webm`, 'v']));
  const root = await h.folder('Learning', tree);
  h.config.set('coursesRoots', [root]);
  return Object.fromEntries(names.map((name) => [name, join(root, name)]));
}

describe('Recent Courses in the Course picker', () => {
  it('lists the 5 most recently opened Courses first, newest first, above the other Courses', async () => {
    const h = await createHarness();
    const folders = await learning(h, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    for (const name of ['F', 'A', 'G', 'C', 'B', 'E']) {
      await h.core.openCourse(folders[name] ?? '');
    }

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'E — (open)',
      'B',
      'C',
      'G',
      'A',
      '── Other Courses',
      'D',
      'F',
      'Add Courses root…',
    ]);
  });
  it('is shared by every workspace of this machine, while each workspace restores its own Course', async () => {
    const h = await createHarness();
    const folders = await learning(h, ['A', 'B']);
    await h.core.openCourse(folders.A ?? '');
    await h.core.openCourse(folders.B ?? '');
    await h.core.close();

    h.restart({ otherWorkspace: true });
    await h.core.restoreCourse();
    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(h.player.shown).toEqual([]);
    expect(rows(h.ui.picker)).toEqual(['── Recent Courses', 'B', 'A', 'Add Courses root…']);
  });

  it('treats another spelling of the open Course’s folder as that Course', async () => {
    const h = await createHarness();
    const folders = await learning(h, ['A']);
    await h.core.openCourse(folders.A ?? '');
    h.player.ready();
    h.player.clearSent();

    await h.core.openCourse(join(h.root, 'Learning', 'A', '..', 'A') + sep);
    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(h.player.sent).toEqual([]);
    expect(rows(h.ui.picker)).toEqual(['── Recent Courses', 'A — (open)', 'Add Courses root…']);
  });

  it('lists a Course once, first, when it is opened again', async () => {
    const h = await createHarness();
    const folders = await learning(h, ['A', 'B', 'C']);
    for (const name of ['A', 'B', 'C', 'A']) {
      await h.core.openCourse(folders[name] ?? '');
    }

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'A — (open)',
      'C',
      'B',
      'Add Courses root…',
    ]);
  });

  it('tags only the Course that is open in this window', async () => {
    const h = await createHarness();
    const folders = await learning(h, ['A', 'B']);
    await h.core.openCourse(folders.A ?? '');
    await h.core.openCourse(folders.B ?? '');

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'B — (open)',
      'A',
      'Add Courses root…',
    ]);
  });

  it('tags nothing while no Course is open', async () => {
    const h = await createHarness();
    await learning(h, ['A']);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['A', 'Add Courses root…']);
  });

  it('keeps Recent for this machine when VS Code starts again', async () => {
    const h = await createHarness();
    const folders = await learning(h, ['A', 'B', 'C']);
    await h.core.openCourse(folders.A ?? '');
    await h.core.openCourse(folders.B ?? '');
    await h.core.close();

    h.restart();
    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'B',
      'A',
      '── Other Courses',
      'C',
      'Add Courses root…',
    ]);
  });

  it('does not list a folder that held no Lessons when it was opened', async () => {
    const h = await createHarness();
    const zipped = await h.folder('Zipped', { 'course.zip': 'z' });
    await h.core.openCourse(zipped);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Add Courses root…']);
  });

  it('lists a Course opened from outside the Courses roots, even with no root set', async () => {
    const h = await createHarness();
    const outside = await h.folder('Downloads/Some Course', { '01 Intro.webm': 'v' });
    await h.core.openCourse(outside);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'Some Course — (open)',
      'Add Courses root…',
    ]);
  });
});

describe('Recent Courses are known Courses for the scan', () => {
  async function sectionsOnlyCourse(h: Harness): Promise<string> {
    const root = await h.folder('Learning', {
      'Algorithms/Part 1/01 Intro.webm': 'v',
      'Algorithms/Part 2/02 Sorting.webm': 'v',
      'Other Course/01 Hello.webm': 'v',
    });
    h.config.set('coursesRoots', [root]);
    return join(root, 'Algorithms');
  }

  it('lists a Course whose Lessons are only in Sections as its Sections until it is opened', async () => {
    const h = await createHarness();
    await sectionsOnlyCourse(h);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      'Other Course',
      'Part 1 — Algorithms',
      'Part 2 — Algorithms',
      'Add Courses root…',
    ]);
  });

  it('lists it as itself once it was opened, for example through a folder URI or Browse…', async () => {
    const h = await createHarness();
    await h.core.openCourse(await sectionsOnlyCourse(h));
    await h.core.openCourse(join(h.root, 'Learning', 'Other Course'));

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'Other Course — (open)',
      'Algorithms',
      'Add Courses root…',
    ]);
  });
});

describe('a Recent Course whose folder has moved', () => {
  async function movedCourse(h: Harness): Promise<{ old: string; moved: string }> {
    const folders = await learning(h, ['A', 'B']);
    const old = folders.A ?? '';
    await h.core.openCourse(old);
    await h.core.openCourse(folders.B ?? '');
    const moved = join(h.root, 'Elsewhere', 'A moved');
    await h.folder('Elsewhere', {});
    await rename(old, moved);
    return { old, moved };
  }

  it('shows as missing, with Locate… and Remove buttons', async () => {
    const h = await createHarness();
    await movedCourse(h);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'B — (open)',
      'A — missing',
      'Add Courses root…',
    ]);
    expect(h.ui.buttonsOf('A')).toEqual(['Locate…', 'Remove']);
    expect(h.ui.buttonsOf('B')).toEqual([]);
  });

  it('drops the Course from Recent when the learner presses Remove, and shows the list again', async () => {
    const h = await createHarness();
    await movedCourse(h);

    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.press('A', 'Remove');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['── Recent Courses', 'B — (open)', 'Add Courses root…']);
    h.ui.dismissPicker();
    h.restart();
    void h.core.pickCourse();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['── Recent Courses', 'B', 'Add Courses root…']);
  });

  it('does not open the Course when the learner picks it: it asks for the new folder', async () => {
    const h = await createHarness();
    await movedCourse(h);

    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('A');
    await h.ui.pickerShown();

    expect(h.ui.folderDialogs).toEqual([{ title: 'Locate “A”', openLabel: 'Locate' }]);
  });
});

describe('Locate…', () => {
  const lessons = {
    '01 Intro.webm': 'video',
    '02 Setup.webm': 'video',
    'notes.md': '#',
  };

  /** The player plays a Lesson of a 600 s length up to `position`, and the learner pauses it. */
  function playToAndPause(h: Harness, lessonId: string, position: number): void {
    h.core.playLesson(lessonId);
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
    h.player.emit({ type: 'paused', lessonId, byUser: true });
  }

  /**
   * The Course “A” is opened and played to 5:00 of its second Lesson, then another Course is
   * opened, and A's folder is moved (renamed into another folder) to the returned path.
   * `readOnly`: A is read-only before it moves and after, so its data is in the extension storage.
   */
  async function playedThenMoved(
    h: Harness,
    { readOnly }: { readOnly: boolean },
  ): Promise<{ old: string; moved: string; makeWritable: () => void }> {
    const root = await h.folder('Learning', {
      ...Object.fromEntries(Object.entries(lessons).map(([name, text]) => [`A/${name}`, text])),
      'B/01 Intro.webm': 'v',
    });
    h.config.set('coursesRoots', [root]);
    const old = join(root, 'A');
    const undo = readOnly ? makeReadOnly(old) : undefined;
    await h.core.openCourse(old);
    h.player.ready();
    playToAndPause(h, '02 Setup.webm', 300);
    await h.core.openCourse(join(root, 'B'));
    await h.settle();
    undo?.();
    await h.folder('Elsewhere', {});
    const moved = join(h.root, 'Elsewhere', 'A moved');
    await rename(old, moved);
    const undoMoved = readOnly ? makeReadOnly(moved) : undefined;
    return { old, moved, makeWritable: () => undoMoved?.() };
  }

  /** The Course picker the learner is working in, and the rows it shows now. */
  let picking: Promise<void> = Promise.resolve();

  /** The learner presses Locate… beside “A” and chooses `folder`; resolves with the picker's rows after. */
  async function locate(h: Harness, folder: string | undefined): Promise<string[]> {
    if (folder !== undefined) {
      h.ui.folderAnswers.push(folder);
    }
    picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.press('A', 'Locate…');
    await h.ui.pickerShown();
    return rows(h.ui.picker);
  }

  /** The learner opens the Course shown as `label`, and the player page loads its Lesson. */
  async function openFromPicker(h: Harness, label: string) {
    h.ui.choose(label);
    await picking;
    h.player.clearSent();
    h.player.ready();
    return h.player.sent.at(-1);
  }

  it('points the entry at the new folder, in the same place, and no longer shows it as missing', async () => {
    const h = await createHarness();
    const { moved } = await playedThenMoved(h, { readOnly: false });

    expect(await locate(h, moved)).toEqual([
      '── Recent Courses',
      'B — (open)',
      'A moved',
      'Add Courses root…',
    ]);
  });

  it('keeps the Progress of a writable Course: it moved along in .followalong', async () => {
    const h = await createHarness();
    const { moved } = await playedThenMoved(h, { readOnly: false });
    await locate(h, moved);

    expect(await openFromPicker(h, 'A moved')).toMatchObject({
      lessonId: '02 Setup.webm',
      startAt: 295,
    });
  });

  it('carries the Progress of a read-only Course to the new folder’s key in the extension storage', async () => {
    const h = await createHarness();
    const { moved } = await playedThenMoved(h, { readOnly: true });
    await locate(h, moved);

    expect(await openFromPicker(h, 'A moved')).toMatchObject({
      lessonId: '02 Setup.webm',
      startAt: 295,
    });
    expect(await h.listFiles(h.storage.folder)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^courses\/A-[0-9a-f]{16}\/progress\.json$/),
        expect.stringMatching(/^courses\/A moved-[0-9a-f]{16}\/progress\.json$/),
      ]),
    );
  });

  it('carries Progress that was not saved yet when the Course that moved is still open', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', { 'A/01 Intro.webm': 'v', 'A/02 Setup.webm': 'v' });
    h.config.set('coursesRoots', [root]);
    const old = join(root, 'A');
    const undo = makeReadOnly(old);
    await h.core.openCourse(old);
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    // Paused once, so the first save is made; then it plays on for a second, which is not saved yet.
    playToAndPause(h, '02 Setup.webm', 100);
    await h.settle();
    h.player.emit({ type: 'played', lessonId: '02 Setup.webm' });
    h.player.emit({ type: 'timeUpdate', lessonId: '02 Setup.webm', position: 101, duration: 600 });
    h.player.emit({ type: 'timeUpdate', lessonId: '02 Setup.webm', position: 102, duration: 600 });
    await h.settle();
    undo();
    await h.folder('Elsewhere', {});
    const moved = join(h.root, 'Elsewhere', 'A moved');
    await rename(old, moved);
    makeReadOnly(moved);

    expect(await locate(h, moved)).toEqual(['── Recent Courses', 'A moved', 'Add Courses root…']);

    expect(await openFromPicker(h, 'A moved')).toMatchObject({
      lessonId: '02 Setup.webm',
      startAt: 97,
    });
  });

  it('carries the Resources of a read-only Course too', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', { 'A/01 Intro.webm': 'v', 'A/notes.md': '#' });
    h.config.set('coursesRoots', [root]);
    const old = join(root, 'A');
    const undo = makeReadOnly(old);
    await h.core.openCourse(old);
    await h.core.attachResource('01 Intro.webm', join(old, 'notes.md'));
    await h.core.openCourse(await h.folder('B', { '01 Intro.webm': 'v' }));
    undo();
    const moved = join(h.root, 'Elsewhere', 'A moved');
    await h.folder('Elsewhere', {});
    await rename(old, moved);
    makeReadOnly(moved);
    await locate(h, moved);

    await openFromPicker(h, 'A moved');

    expect(JSON.stringify(h.ui.lessonTree)).toContain('notes.md');
  });

  it('never writes over a Progress file in the new folder that it cannot read', async () => {
    const h = await createHarness();
    const { moved, makeWritable } = await playedThenMoved(h, { readOnly: true });
    const damaged = '{"version": 1, "data": ';
    const progressPath = join(moved, '.followalong', 'progress.json');
    makeWritable();
    await mkdir(join(moved, '.followalong'));
    await writeFile(progressPath, damaged);
    await locate(h, moved);

    expect(await openFromPicker(h, 'A moved')).toMatchObject({
      lessonId: '02 Setup.webm',
      startAt: 295,
    });
    expect(await readFile(progressPath, 'utf8')).toBe(damaged);
  });

  it('merges with Progress the new folder already has, the newer entry of each Lesson winning', async () => {
    const h = await createHarness();
    const { moved, makeWritable } = await playedThenMoved(h, { readOnly: true });
    makeWritable();
    await mkdir(join(moved, '.followalong'));
    await writeFile(
      join(moved, '.followalong', 'progress.json'),
      JSON.stringify({
        version: 1,
        data: {
          lessons: {
            '01 Intro.webm': { position: 100, duration: 600, savedAt: Date.UTC(2030, 0, 1) },
          },
          last: { lessonId: '01 Intro.webm', savedAt: Date.UTC(2030, 0, 1) },
        },
      }),
    );
    await locate(h, moved);

    expect(await openFromPicker(h, 'A moved')).toMatchObject({
      lessonId: '01 Intro.webm',
      startAt: 95,
    });
    h.core.playLesson('02 Setup.webm');
    expect(h.player.sent.at(-1)).toMatchObject({ lessonId: '02 Setup.webm', startAt: 295 });
  });

  it('does not re-point the entry to a folder with no Lessons, and says so', async () => {
    const h = await createHarness();
    await playedThenMoved(h, { readOnly: false });
    const empty = await h.folder('Elsewhere/Empty', { 'code.zip': 'z' });

    expect(await locate(h, empty)).toEqual([
      '── Recent Courses',
      'B — (open)',
      'A — missing',
      'Add Courses root…',
    ]);
    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: 'FollowAlong found no Lessons (.mp4 or .webm) in “Empty”, so “A” still points to its old folder.',
      },
    ]);
  });

  it('changes nothing when the learner cancels the folder dialog', async () => {
    const h = await createHarness();
    await playedThenMoved(h, { readOnly: false });

    expect(await locate(h, undefined)).toEqual([
      '── Recent Courses',
      'B — (open)',
      'A — missing',
      'Add Courses root…',
    ]);
  });
});

describe('picking the Course that is already open', () => {
  function playTo(h: Harness, lessonId: string, position: number): void {
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
  }

  it('keeps the Lesson that plays: no reload, no jump to the first Lesson', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', { 'A/01 Intro.webm': 'v', 'A/02 Setup.webm': 'v' });
    h.config.set('coursesRoots', [root]);
    await h.core.openCourse(join(root, 'A'));
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 300);
    h.player.clearSent();

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('A');
    await picking;

    expect(h.player.sent).toEqual([]);
    expect(h.ui.selectedLesson).toBe('02 Setup.webm');
  });

  it('opens the Course again, paused where the learner left it, when the player was closed', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', { 'A/01 Intro.webm': 'v', 'A/02 Setup.webm': 'v' });
    h.config.set('coursesRoots', [root]);
    await h.core.openCourse(join(root, 'A'));
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 300);
    h.player.emit({ type: 'paused', lessonId: '02 Setup.webm', byUser: true });
    h.player.close();
    h.player.clearSent();

    await h.core.openCourse(join(root, 'A'));
    h.player.ready();

    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '02 Setup.webm', startAt: 295, autoplay: false },
    ]);
  });
});

describe('while another Course is opening', () => {
  const opening = { severity: 'info', text: 'FollowAlong is opening a Course…' } as const;

  /** Course “First” plays; “Second” has read its folder and is storing its folder on a slow disk. */
  async function switching(h: Harness) {
    const root = await h.folder('Learning', {
      'First/01 Intro.webm': 'v',
      'First/02 Setup.webm': 'v',
      'Second/01 Intro.webm': 'v',
    });
    h.config.set('coursesRoots', [root]);
    await h.core.openCourse(join(root, 'First'));
    h.player.ready();
    h.player.clearSent();
    const write = h.holdWorkspaceWrite();
    const second = h.core.openCourse(join(root, 'Second'));
    await write.reached;
    return {
      finish: async () => {
        write.release();
        await second;
      },
    };
  }

  it('tells the learner when a click on a Lesson is refused', async () => {
    const h = await createHarness();
    const { finish } = await switching(h);

    h.core.playLesson('02 Setup.webm');

    expect(h.ui.messages).toEqual([opening]);
    expect(h.player.sent).toEqual([]);
    await finish();
  });

  it('tells the learner, not “no Lesson is open”, when Next or Previous is pressed', async () => {
    const h = await createHarness();
    const { finish } = await switching(h);

    h.core.nextLesson();
    h.core.previousLesson();

    expect(h.ui.messages).toEqual([opening, opening]);
    await finish();
  });

  it('tells the learner, and opens no Lesson picker, when Go to Lesson… is used', async () => {
    const h = await createHarness();
    const { finish } = await switching(h);

    await h.core.goToLesson();

    expect(h.ui.messages).toEqual([opening]);
    expect(h.ui.picker).toBeUndefined();
    await finish();
  });

  it('plays Lessons again once the Course is open', async () => {
    const h = await createHarness();
    const { finish } = await switching(h);
    await finish();
    h.ui.messages.length = 0;
    h.player.clearSent();

    h.core.playLesson('01 Intro.webm');

    expect(h.ui.messages).toEqual([]);
    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: '01 Intro.webm' }]);
  });
});

describe('a Course that cannot be stored as open', () => {
  it('leaves the Course that was open as it was: its tree, and its Lessons by id', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', {
      'First/01 Intro.webm': 'v',
      'First/02 Setup.webm': 'v',
      'Second/01 Intro.webm': 'v',
    });
    h.config.set('coursesRoots', [root]);
    await h.core.openCourse(join(root, 'First'));
    h.player.ready();
    const treeBefore = h.ui.lessonTree;
    h.player.clearSent();
    h.failNextWrite('workspace', 'disk full');

    await expect(h.core.openCourse(join(root, 'Second'))).rejects.toThrow('disk full');
    h.core.playLesson('01 Intro.webm');

    expect(h.ui.lessonTree).toEqual(treeBefore);
    expect(h.player.sent).toMatchObject([
      {
        type: 'load',
        lessonId: '01 Intro.webm',
        videoUri: h.player.resourceUri(join(root, 'First', '01 Intro.webm')),
      },
    ]);
  });

  it('does not list the Course as recent, and the next open works', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', {
      'First/01 Intro.webm': 'v',
      'Second/01 Intro.webm': 'v',
    });
    h.config.set('coursesRoots', [root]);
    await h.core.openCourse(join(root, 'First'));
    h.failNextWrite('workspace', 'disk full');
    await expect(h.core.openCourse(join(root, 'Second'))).rejects.toThrow('disk full');

    await h.core.openCourse(join(root, 'Second'));
    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      '── Recent Courses',
      'Second — (open)',
      'First',
      'Add Courses root…',
    ]);
  });
});

describe('Recent that cannot be stored', () => {
  it('does not stop the Course from opening, and says nothing to the learner', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', { 'First/01 Intro.webm': 'v' });
    h.failNextWrite('global', 'disk full');

    await h.core.openCourse(join(root, 'First'));
    h.player.ready();

    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: '01 Intro.webm' }]);
    expect(h.ui.messages).toEqual([]);
  });
});
