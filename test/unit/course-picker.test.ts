import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness } from './harness.js';

/** The picker as the learner reads it, top to bottom: a separator as `── label`, an item as its label. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator' ? `── ${entry.label}` : entry.label,
  );
}

describe('the Course picker', () => {
  it('offers only “Add Courses root…” while no Courses root is set', async () => {
    const h = await createHarness();

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Add Courses root…']);
  });

  it('writes the folder the learner chooses for “Add Courses root…” to the setting', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', {});
    h.ui.folderAnswers.push(root);

    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Add Courses root…');
    await h.ui.pickerShown();

    expect(h.ui.folderDialogs).toEqual([{ title: 'Add Courses root', openLabel: 'Add' }]);
    expect(h.config.get('coursesRoots')).toEqual([root]);
  });

  it('opens again after “Add Courses root…”, listing the Courses of the new root', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Some Course/intro.webm': 'v' });
    h.ui.folderAnswers.push(learning);

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Add Courses root…');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Some Course', 'Add Courses root…']);
    h.ui.choose('Some Course');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      { type: 'load', videoUri: h.player.resourceUri(join(learning, 'Some Course', 'intro.webm')) },
    ]);
  });

  it('adds a root after the ones already set, and never twice', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {});
    const more = await h.folder('More', {});
    h.config.set('coursesRoots', [learning]);
    h.ui.folderAnswers.push(more, more);

    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Add Courses root…');
    await h.ui.pickerShown();
    h.ui.choose('Add Courses root…');
    await h.ui.pickerShown();

    expect(h.config.get('coursesRoots')).toEqual([learning, more]);
  });

  it('writes nothing when the learner cancels the folder dialog', async () => {
    const h = await createHarness();

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Add Courses root…');
    await picking;

    expect(h.config.get('coursesRoots')).toBeUndefined();
    expect(h.ui.picker).toBeUndefined();
  });

  it('lists every Course under the Courses roots A–Z, then “Add Courses root…”', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'TypeScript Deep Dive/01 Intro.mp4': 'v',
      'algorithms/lesson1.webm': 'v',
      'Web/React Basics/01 Hello.webm': 'v',
      'Web/Vue Basics/01 Hello.webm': 'v',
      'notes/readme.txt': 'not a Course',
    });
    const more = await h.folder('More', { 'CSS Grid/lesson10.mp4': 'v' });
    h.config.set('coursesRoots', [learning, more]);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      'algorithms',
      'CSS Grid',
      'React Basics',
      'TypeScript Deep Dive',
      'Vue Basics',
      'Add Courses root…',
    ]);
  });

  it('stops at the first folder on a branch that holds a video: its subfolders are its Sections', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Node Course/01 Welcome.mp4': 'v',
      'Node Course/Section 2/02 Modules.mp4': 'v',
      'Node Course/Section 2/extra/03 Deep.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Node Course', 'Add Courses root…']);
  });

  it('skips hidden folders, node_modules and .git', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Real Course/01 Intro.mp4': 'v',
      '.hidden course/01 Intro.mp4': 'v',
      'project/node_modules/some-package/demo.mp4': 'v',
      'project/.git/objects/demo.webm': 'v',
      'Real Course/.followalong/sound.webm': 'v',
    });
    h.config.set('coursesRoots', [learning]);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Real Course', 'Add Courses root…']);
  });

  it('lists the Courses of the other roots, and says which root it cannot read', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Real Course/01 Intro.mp4': 'v' });
    const unplugged = join(h.root, 'Unplugged drive');
    h.config.set('coursesRoots', [unplugged, learning]);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Real Course', 'Add Courses root…']);
    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: `FollowAlong can't read the Courses root “${unplugged}”. Is the folder or drive still there?`,
      },
    ]);
  });

  it('leaves out a folder under a root that it cannot read, and lists the rest', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Real Course/01 Intro.mp4': 'v',
      'System Volume Information/demo.mp4': 'v',
    });
    h.makeUnreadable(join(learning, 'System Volume Information'));
    h.config.set('coursesRoots', [learning]);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Real Course', 'Add Courses root…']);
    expect(h.ui.messages).toEqual([]);
  });

  it('opens the Course the learner picks, in place of the open one, without asking', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'First Course/a.webm': 'v',
      'Second Course/b.webm': 'v',
      'Second Course/Section 1/c.webm': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'First Course'));
    h.player.ready();
    h.player.clearSent();

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Second Course');
    await picking;

    const second = join(learning, 'Second Course');
    expect(h.player.shown.at(-1)?.title).toBe('b');
    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: 'b.webm', videoUri: h.player.resourceUri(join(second, 'b.webm')) },
    ]);
    expect(h.ui.lessonTree?.nodes.map((node) => node.label)).toEqual(['b', 'Section 1']);
    // No confirmation: nothing else was asked or said.
    expect(h.ui.pickers).toHaveLength(1);
    expect(h.ui.messages).toEqual([]);
  });

  it('changes nothing in the Courses roots when it lists and opens a Course', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'First Course/a.webm': 'v',
      'Second Course/b.webm': 'v',
      'code.zip': 'zip',
    });
    const before = await h.listFiles(learning);
    h.config.set('coursesRoots', [learning]);

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Second Course');
    await picking;
    h.player.ready();

    expect(await h.listFiles(learning)).toEqual(before);
  });

  it('lists a Course once when one Courses root is inside another', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React Basics/01 Hello.webm': 'v',
      'Web/Vue Basics/01 Hello.webm': 'v',
      'Node Course/01 Welcome.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning, join(learning, 'Web')]);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual([
      'Node Course',
      'React Basics',
      'Vue Basics',
      'Add Courses root…',
    ]);
  });

  it('keeps the player page when the learner picks another Course under the Courses roots', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'First Course/a.webm': 'v',
      'Second Course/b.webm': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    const first = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('First Course');
    await first;
    h.player.ready();
    h.player.clearSent();

    // The page keeps the click that lets it start playback (#12 D3) only if it is not reloaded,
    // which it is whenever the folders it may read change: they are the Courses roots.
    const second = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Second Course');
    await second;

    expect(h.player.shown.map((shown) => shown.resourceRoots)).toEqual([
      [learning, join(h.storage.folder, 'courses')],
      [learning, join(h.storage.folder, 'courses')],
    ]);
    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: 'b.webm' }]);
  });

  it('lets the player read a Course outside the Courses roots too', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'First Course/a.webm': 'v' });
    const elsewhere = await h.folder('Elsewhere', { 'c.webm': 'v' });
    h.config.set('coursesRoots', [learning]);

    await h.core.openCourse(elsewhere);

    expect(h.player.shown.map((shown) => shown.resourceRoots)).toEqual([
      [learning, elsewhere, join(h.storage.folder, 'courses')],
    ]);
  });

  it('ignores a late event from the Lesson of the previous Course in the same player page', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'First Course/01.webm': 'v',
      'Second Course/01.webm': 'v',
      'Second Course/02.webm': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'First Course'));
    h.player.ready();
    const firstLoad = h.player.sent.at(-1);
    await h.core.openCourse(join(learning, 'Second Course'));
    h.player.clearSent();

    // The page is kept (same Courses roots), so a report it sent about the first Course's
    // 01.webm can arrive after the second Course's 01.webm was loaded.
    h.player.emit({
      type: 'ended',
      lessonId: '01.webm',
      ...(firstLoad?.type === 'load' ? { loadId: firstLoad.loadId } : {}),
    });

    expect(h.player.sent).toEqual([]);
  });

  it('takes two spellings of one Courses root as one root', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Some Course/intro.webm': 'v' });
    // A trailing separator, a `..` segment, and on Windows another letter case: the same folder.
    const spellings = [
      `${learning}${sep}`,
      `${learning}${sep}Some Course${sep}..`,
      ...(process.platform === 'win32' ? [learning.toUpperCase(), learning.toLowerCase()] : []),
    ];
    h.config.set('coursesRoots', [learning, ...spellings]);
    h.ui.folderAnswers.push(`${learning}${sep}`);

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Some Course', 'Add Courses root…']);
    h.ui.choose('Add Courses root…');
    await h.ui.pickerShown();
    h.ui.choose('Some Course');
    await picking;

    expect(h.config.get('coursesRoots')).toEqual([learning, ...spellings]);
    expect(h.player.shown.map((shown) => shown.resourceRoots)).toEqual([
      [learning, join(h.storage.folder, 'courses')],
    ]);
  });

  it('skips a Courses root that is not an absolute path, and says so once', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Some Course/intro.webm': 'v' });
    // On Windows a rooted path without a drive (`\Learning`) is not a full path either: it would
    // name a folder on whatever drive VS Code runs from. Nor is a verbatim or device path, which
    // would spell a root a second way (ADR 0033).
    const driveless =
      process.platform === 'win32'
        ? ['\\Learning', '/Learning', '\\\\?\\d:\\Learning', '\\\\.\\d:\\Learning']
        : [];
    h.config.set('coursesRoots', ['.', '~', `relative${sep}folder`, ...driveless, learning]);

    const first = h.core.pickCourse();
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Some Course', 'Add Courses root…']);
    h.ui.choose('Some Course');
    await first;
    const second = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    await second;

    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: `FollowAlong skips the Courses roots ${['.', '~', `relative${sep}folder`, ...driveless].map((entry) => `“${entry}”`).join(', ')}: a Courses root must be a full path, such as D:\\Learning.`,
      },
    ]);
    expect(h.player.shown.map((shown) => shown.resourceRoots)).toEqual([
      [learning, join(h.storage.folder, 'courses')],
    ]);
  });

  it("skips a drive's recycle bin and System Volume Information", async () => {
    const h = await createHarness();
    const drive = await h.folder('Drive', {
      'Real Course/01 Intro.mp4': 'v',
      '$RECYCLE.BIN/S-1-5-21-1000/Deleted Course/01 Intro.mp4': 'v',
      'System Volume Information/Snapshot/demo.mp4': 'v',
    });
    h.config.set('coursesRoots', [drive]);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Real Course', 'Add Courses root…']);
  });

  it('says once per window that a Courses root cannot be read', async () => {
    const h = await createHarness();
    const unplugged = join(h.root, 'Unplugged drive');
    h.config.set('coursesRoots', [unplugged]);

    for (let open = 0; open < 2; open += 1) {
      const picking = h.core.pickCourse();
      await h.ui.pickerShown();
      h.ui.dismissPicker();
      await picking;
    }

    expect(h.ui.messages).toHaveLength(1);
  });

  it('gives the player a Course whose path differs in letter case from its root as its own folder', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Some Course/intro.webm': 'v' });
    // VS Code matches the player's files against its folders by spelling, letter case included.
    const otherCase = await h.folder(join('LEARNING', 'Some Course'), { 'intro.webm': 'v' });
    h.config.set('coursesRoots', [learning]);

    await h.core.openCourse(otherCase);

    expect(h.player.shown.map((shown) => shown.resourceRoots)).toEqual([
      [learning, otherCase, join(h.storage.folder, 'courses')],
    ]);
  });
});
