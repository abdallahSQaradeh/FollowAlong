import { isAbsolute, join, parse, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNodeFileSystem } from '../../src/adapters/node/file-system.js';
import { buildFolderBrowser } from '../../src/core/folder-browser.js';
import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';

/** The quick pick as the learner reads it, top to bottom: a separator as `── label`, an item as its label. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator' ? `── ${entry.label}` : entry.label,
  );
}

/** Opens the Course picker and picks “Browse…”: the learner is in the Folder browser. */
async function browse(h: Harness): Promise<void> {
  void h.core.pickCourse();
  await h.ui.pickerShown();
  h.ui.choose('Browse…');
  await h.ui.pickerShown();
}

describe('Browse… in the Course picker', () => {
  it('walks the Courses roots in the same quick pick, with a way back to the Courses', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Node/01 Intro.mp4': 'v' });
    const more = await h.folder('More', {});
    h.config.set('coursesRoots', [learning, more]);

    await browse(h);

    expect(rows(h.ui.picker)).toEqual(['Back to Courses', 'Learning', 'More']);
    expect(h.ui.pickers).toHaveLength(1);
  });
});

describe('walking folders in the Folder browser', () => {
  it('lists a folder’s subfolders and then its videos, in natural order, and nothing else', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React/lesson10.mp4': 'v',
      'Web/React/lesson2.mp4': 'v',
      'Web/React/Intro.WEBM': 'v',
      'Web/React/notes.pdf': 'not a video',
      'Web/React/slides/s1.pdf': 'a folder without videos is still a folder',
      'Web/React/.git/config': 'hidden',
      'Web/React/node_modules/x.mp4': 'never walked',
      'Web/Vue/lesson1.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await browse(h);

    h.ui.choose('Learning');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Web']);

    h.ui.choose('Web');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'React', 'Vue']);

    h.ui.choose('React');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual([
      'Up',
      'Open “React” as Course',
      'slides',
      'Intro.WEBM',
      'lesson2.mp4',
      'lesson10.mp4',
    ]);
    expect(h.ui.pickers).toHaveLength(1);
  });

  it('goes back up one folder at a time, also above a Courses root', async () => {
    const h = await createHarness();
    const courses = await h.folder('Downloads/Courses', { 'Node/01 Intro.mp4': 'v' });
    await h.folder('Downloads/Other', { 'x/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [courses]);
    await browse(h);
    h.ui.choose('Courses');
    await h.ui.pickerShown();
    h.ui.choose('Node');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Up', 'Open “Node” as Course', '01 Intro.mp4']);

    h.ui.choose('Up');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Node']);

    h.ui.choose('Up');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Courses', 'Other']);
  });
});

describe('Open as Course in the Folder browser', () => {
  it('is offered only on folders that directly hold videos', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React/01 Intro.mp4': 'v',
      'Web/Vue/01 Intro.WEBM': 'v',
      'Web/Notes/readme.txt': 'no videos',
      'Web/Zipped/course.zip': 'only a zip',
      'Web/Sections/Part 1/01 Intro.mp4': 'videos only below',
    });
    h.config.set('coursesRoots', [learning]);
    await browse(h);
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    h.ui.choose('Web');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Up', 'Notes', 'React', 'Sections', 'Vue', 'Zipped']);
    expect(h.ui.buttonsOf('React')).toEqual(['Open as Course']);
    expect(h.ui.buttonsOf('Vue')).toEqual(['Open as Course']);
    expect(h.ui.buttonsOf('Notes')).toEqual([]);
    expect(h.ui.buttonsOf('Zipped')).toEqual([]);
    expect(h.ui.buttonsOf('Sections')).toEqual([]);
  });

  it('shows the folders at once and is busy until it knows which ones hold videos', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Web/React/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    await browse(h);
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    const react = join(learning, 'Web', 'React');
    const release = h.holdReads(react);

    h.ui.choose('Web');
    // The folder is read, and listed at once: the first update after the busy one.
    await h.ui.nextUpdate();

    expect(h.ui.pickerBusy).toBe(true);
    expect(rows(h.ui.picker)).toEqual(['Up', 'React']);
    expect(h.ui.buttonsOf('React')).toEqual([]);
    release();
    await h.ui.pickerShown();
    expect(h.ui.buttonsOf('React')).toEqual(['Open as Course']);
  });

  it('opens the folder as the Course when the learner presses it, and closes the picker', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React/01 Intro.mp4': 'v',
      'Web/React/02 State.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    h.ui.choose('Web');
    await h.ui.pickerShown();

    h.ui.press('React', 'Open as Course');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      {
        type: 'load',
        videoUri: h.player.resourceUri(join(learning, 'Web', 'React', '01 Intro.mp4')),
      },
    ]);
    expect(h.ui.picker).toBeUndefined();
  });

  it('is also offered inside a folder that holds videos, for the folder itself', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Web/React/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    h.ui.choose('Web');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'React']);
    h.ui.choose('React');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Up', 'Open “React” as Course', '01 Intro.mp4']);
    h.ui.choose('Open “React” as Course');
    await picking;
    h.player.ready();
    expect(h.player.sent).toMatchObject([{ type: 'load' }]);
  });
});

describe('picking a video in the Folder browser', () => {
  /** Browses to `Learning/<folders>` from the Course picker; resolves the picker's answer. */
  async function walkTo(
    h: Harness,
    root: string,
    ...folders: string[]
  ): Promise<{ readonly picking: Promise<void> }> {
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    for (const label of [root, ...folders]) {
      h.ui.choose(label);
      await h.ui.pickerShown();
    }
    return { picking };
  }

  it('opens its folder as the Course and plays that video, not the first Lesson', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'React/01 Intro.mp4': 'v',
      'React/02 State.mp4': 'v',
      'React/03 Hooks.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    const { picking } = await walkTo(h, 'Learning', 'React');

    h.ui.choose('02 State.mp4');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      {
        type: 'load',
        videoUri: h.player.resourceUri(join(learning, 'React', '02 State.mp4')),
        autoplay: true,
      },
    ]);
    expect(h.ui.selectedLesson).toBe('02 State.mp4');
    expect(h.ui.lessonTree?.nodes.map((node) => node.kind)).toEqual(['lesson', 'lesson', 'lesson']);
    expect(h.ui.picker).toBeUndefined();
  });

  it('plays it from 5 s before where the learner left it, as any picked Lesson does', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'React/01 Intro.mp4': 'v',
      'React/02 State.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'React'));
    h.player.ready();
    h.core.playLesson('02 State.mp4');
    h.player.emit({ type: 'played', lessonId: '02 State.mp4' });
    h.player.emit({ type: 'timeUpdate', lessonId: '02 State.mp4', position: 120, duration: 600 });
    h.player.emit({ type: 'paused', lessonId: '02 State.mp4', byUser: true });
    h.core.playLesson('01 Intro.mp4');
    await h.settle();
    h.restart();
    h.player.clearSent();
    const { picking } = await walkTo(h, 'Learning', 'React');
    h.player.clearSent();

    h.ui.choose('02 State.mp4');
    await picking;

    h.player.ready();
    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '02 State.mp4', startAt: 115, autoplay: true },
    ]);
  });
});

describe('Browse… and the Course that is open', () => {
  /** Picks Courses, then Browse…, then walks to `folders`; resolves the picker's answer. */
  async function walkFromPicker(
    h: Harness,
    ...folders: string[]
  ): Promise<{ readonly picking: Promise<void> }> {
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    for (const label of folders) {
      h.ui.choose(label);
      await h.ui.pickerShown();
    }
    return { picking };
  }

  it('plays a video of the open Course without opening it again, keeping its Progress', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'React/01 Intro.mp4': 'v',
      'React/02 State.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'React'));
    h.player.ready();
    h.player.clearSent();
    const draws = h.ui.lessonTreeDraws;
    const { picking } = await walkFromPicker(h, 'Learning', 'React');

    h.ui.choose('02 State.mp4');
    await picking;

    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '02 State.mp4', autoplay: true },
    ]);
    expect(h.ui.lessonTreeDraws).toBeLessThanOrEqual(draws + 1);
    expect(h.ui.selectedLesson).toBe('02 State.mp4');
  });

  it('keeps what plays when the learner opens the open Course again as a Course', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'React/01 Intro.mp4': 'v',
      'React/02 State.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'React'));
    h.player.ready();
    h.core.playLesson('02 State.mp4');
    h.player.clearSent();
    const { picking } = await walkFromPicker(h, 'Learning', 'React');

    h.ui.choose('Open “React” as Course');
    await picking;

    expect(h.player.sent).toEqual([]);
    expect(h.ui.selectedLesson).toBe('02 State.mp4');
  });
});

describe('where Browse… starts', () => {
  it('starts at the drives or the home folder when no Courses root is set', async () => {
    const h = await createHarness();
    const home = await h.folder('home', { 'Videos/01 Intro.mp4': 'v' });
    const drive = await h.folder('D', {});
    h.setStartingFolders(home, drive);

    await browse(h);

    expect(rows(h.ui.picker)).toEqual(['Back to Courses', 'home', 'D']);
    h.ui.choose('home');
    await h.ui.pickerShown();
    expect(rows(h.ui.picker)).toEqual(['Up', 'Videos']);
  });

  it('also offers the drives or the home folder under the roots, to reach what is outside them', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {});
    const home = await h.folder('home', {});
    h.config.set('coursesRoots', [learning]);
    h.setStartingFolders(home);

    await browse(h);

    expect(rows(h.ui.picker)).toEqual(['Back to Courses', 'Learning', '── Elsewhere', 'home']);
  });

  it('offers Open as Course on a root or a drive that holds videos itself', async () => {
    const h = await createHarness();
    const root = await h.folder('Videos', { '01 Intro.mp4': 'v' });
    const other = await h.folder('Other', { 'notes.txt': 'n' });
    h.config.set('coursesRoots', [root, other]);

    await browse(h);

    expect(h.ui.buttonsOf('Videos')).toEqual(['Open as Course']);
    expect(h.ui.buttonsOf('Other')).toEqual([]);
  });

  it('returns to the Courses, and the Courses are listed again', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Node/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    await browse(h);

    h.ui.choose('Back to Courses');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Node', 'Browse…', 'Add Courses root…']);
  });
});

describe('a Course outside the Courses roots', () => {
  it('opens, and the player may read its folder, which reloads the page once', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Node/01 Intro.mp4': 'v' });
    const elsewhere = await h.folder('Elsewhere/Stuff', { '01 Talk.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'Node'));
    h.player.ready();
    h.setStartingFolders(join(h.root, 'Elsewhere'));
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    h.ui.choose('Elsewhere');
    await h.ui.pickerShown();
    h.ui.choose('Stuff');
    await h.ui.pickerShown();

    h.ui.choose('01 Talk.mp4');
    await picking;

    expect(h.player.shown.at(-1)?.resourceRoots).toContain(elsewhere);
    expect(h.player.shown.at(-1)?.resourceRoots).toContain(learning);
  });
});

describe('a folder the learner cannot read', () => {
  it('tells them, and the quick pick stays where it was', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Locked/01 Intro.mp4': 'v', 'Open/x.txt': 'n' });
    h.config.set('coursesRoots', [learning]);
    await browse(h);
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    h.makeUnreadable(join(learning, 'Locked'));

    h.ui.choose('Locked');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Up', 'Locked', 'Open']);
    expect(h.ui.messages).toEqual([
      { severity: 'warning', text: "FollowAlong can't read the folder “Locked”." },
    ]);
    expect(h.ui.pickerBusy).toBe(false);
  });
});

describe('the Folder browser while the Courses roots are scanned', () => {
  it('keeps showing the folders when the scan lands', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Node/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    const release = h.holdReads(learning);
    void h.core.pickCourse();
    await h.ui.pickerOpened();
    h.ui.choose('Browse…');
    release();
    // The scan reads the disk for real: it has landed once those reads are done and answered.
    await h.settle();
    await new Promise((resolve) => setImmediate(resolve));

    expect(rows(h.ui.picker)).toEqual(['Back to Courses', 'Learning']);
  });
});

describe('the folder browser model', () => {
  it('goes up to the top of the browser from the root of a drive, which has no folder above it', () => {
    const driveRoot = parse(process.cwd()).root;

    const model = buildFolderBrowser({
      kind: 'folder',
      folder: driveRoot,
      folders: [],
      videos: [],
    });

    expect(model.entries[0]).toMatchObject({
      label: 'Up',
      intent: { type: 'browseTo', folder: undefined },
    });
  });

  it('offers Open as Course only on a folder that was looked at and holds videos', () => {
    const model = buildFolderBrowser({
      kind: 'folder',
      folder: join(sep, 'courses'),
      folders: [
        { path: join(sep, 'courses', 'a'), holdsVideos: true },
        { path: join(sep, 'courses', 'b'), holdsVideos: false },
        { path: join(sep, 'courses', 'c') },
      ],
      videos: [],
    });

    const buttons = model.entries.flatMap((entry) =>
      entry.kind === 'item' ? [[entry.label, (entry.buttons ?? []).map((b) => b.label)]] : [],
    );
    expect(buttons).toEqual([
      ['Up', []],
      ['a', ['Open as Course']],
      ['b', []],
      ['c', []],
    ]);
  });
});

describe('the File system port’s starting folders', () => {
  it('are existing, absolute folders: the drives that are there, or the home folder', async () => {
    const folders = await createNodeFileSystem().startingFolders();

    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(isAbsolute(folder)).toBe(true);
      expect(await createNodeFileSystem().exists(folder)).toBe(true);
    }
  });
});

describe('Browse… edge cases found in review', () => {
  it('opens the Course again for a picked video the open Course does not know yet', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'React/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    await h.core.openCourse(join(learning, 'React'));
    h.player.ready();
    // Downloaded after the Course was opened.
    await h.folder('Learning', { 'React/02 State.mp4': 'v' });
    h.player.clearSent();
    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    for (const label of ['Learning', 'React']) {
      h.ui.choose(label);
      await h.ui.pickerShown();
    }

    h.ui.choose('02 State.mp4');
    await picking;

    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '02 State.mp4', autoplay: true },
    ]);
    expect(h.ui.lessonTree?.nodes).toHaveLength(2);
  });

  it('stops being busy, and says why in the log, when a root cannot be looked at', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Node/01 Intro.mp4': 'v' });
    h.config.set('coursesRoots', [learning]);
    void h.core.pickCourse();
    await h.ui.pickerShown();
    h.breakReads(learning, 'the drive went away in a way nobody planned for');

    h.ui.choose('Browse…');
    await h.ui.pickerShown();

    expect(rows(h.ui.picker)).toEqual(['Back to Courses', 'Learning']);
    expect(h.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('the drive went away') as unknown,
      }),
    );
  });

  it('stays busy while it looks at folders, also when the Course scan lands in the meantime', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Node/01 Intro.mp4': 'v',
      'Node/Part 1/02 More.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);
    const scan = h.holdFirstRead(learning);
    void h.core.pickCourse();
    await scan.reached;
    h.ui.choose('Browse…');
    await h.ui.pickerShown();
    h.ui.choose('Learning');
    await h.ui.pickerShown();
    const release = h.holdReads(join(learning, 'Node', 'Part 1'));
    h.ui.choose('Node');
    await h.ui.nextUpdate();

    scan.release();
    // Real reads take a few milliseconds: this is long enough for the scan to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(h.ui.pickerBusy).toBe(true);
    release();
    await h.ui.pickerShown();
    expect(h.ui.buttonsOf('Part 1')).toEqual(['Open as Course']);
  });
});
