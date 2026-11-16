import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness } from './harness.js';

/** The picker as the learner reads it, top to bottom: a separator as `── label`, an item as its label. */
function rows(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).map((entry) =>
    entry.kind === 'separator' ? `── ${entry.label}` : entry.label,
  );
}

/** Lets the core's file system reads and writes run until the next quick pick or dialog. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('the Course picker', () => {
  it('offers only “Add Courses root…” while no Courses root is set', async () => {
    const h = await createHarness();

    void h.core.pickCourse();
    await settle();

    expect(rows(h.ui.picker)).toEqual(['Add Courses root…']);
  });

  it('writes the folder the learner chooses for “Add Courses root…” to the setting', async () => {
    const h = await createHarness();
    const root = await h.folder('Learning', {});
    h.ui.folderAnswers.push(root);

    void h.core.pickCourse();
    await settle();
    h.ui.choose('Add Courses root…');
    await settle();

    expect(h.ui.folderDialogs).toEqual([{ title: 'Add Courses root', openLabel: 'Add' }]);
    expect(h.config.get('coursesRoots')).toEqual([root]);
  });

  it('opens again after “Add Courses root…”, listing the Courses of the new root', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Some Course/intro.webm': 'v' });
    h.ui.folderAnswers.push(learning);

    const picking = h.core.pickCourse();
    await settle();
    h.ui.choose('Add Courses root…');
    await settle();
    expect(rows(h.ui.picker)).toEqual(['Some Course', 'Add Courses root…']);
    h.ui.choose('Some Course');
    await picking;

    expect(h.player.shown.map((shown) => shown.resourceRoots[0])).toEqual([
      join(learning, 'Some Course'),
    ]);
  });

  it('adds a root after the ones already set, and never twice', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {});
    const more = await h.folder('More', {});
    h.config.set('coursesRoots', [learning]);
    h.ui.folderAnswers.push(more, more);

    void h.core.pickCourse();
    await settle();
    h.ui.choose('Add Courses root…');
    await settle();
    h.ui.choose('Add Courses root…');
    await settle();

    expect(h.config.get('coursesRoots')).toEqual([learning, more]);
  });

  it('writes nothing when the learner cancels the folder dialog', async () => {
    const h = await createHarness();

    const picking = h.core.pickCourse();
    await settle();
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
      'notes/readme.txt': 'not a Course',
    });
    const more = await h.folder('More', { 'CSS Grid/lesson10.mp4': 'v' });
    h.config.set('coursesRoots', [learning, more]);

    void h.core.pickCourse();
    await settle();

    expect(rows(h.ui.picker)).toEqual([
      'algorithms',
      'CSS Grid',
      'React Basics',
      'TypeScript Deep Dive',
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
    await settle();

    expect(rows(h.ui.picker)).toEqual(['Node Course', 'Add Courses root…']);
  });

  it('skips hidden folders, node_modules and .git', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Real Course/01 Intro.mp4': 'v',
      '.hidden course/01 Intro.mp4': 'v',
      'project/node_modules/some-package/demo.mp4': 'v',
      'project/.git/objects/clip.webm': 'v',
      '.followalong/sound.webm': 'v',
    });
    h.config.set('coursesRoots', [learning]);

    void h.core.pickCourse();
    await settle();

    expect(rows(h.ui.picker)).toEqual(['Real Course', 'Add Courses root…']);
  });

  it('lists the Courses of the other roots, and says which root it cannot read', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Real Course/01 Intro.mp4': 'v' });
    const unplugged = join(h.root, 'Unplugged drive');
    h.config.set('coursesRoots', [unplugged, learning]);

    void h.core.pickCourse();
    await settle();

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
      'System Volume Information/clip.mp4': 'v',
    });
    h.makeUnreadable(join(learning, 'System Volume Information'));
    h.config.set('coursesRoots', [learning]);

    void h.core.pickCourse();
    await settle();

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
    await settle();
    h.ui.choose('Second Course');
    await picking;
    h.player.ready();

    const second = join(learning, 'Second Course');
    expect(h.player.shown.at(-1)).toEqual({
      title: 'b',
      resourceRoots: [second, h.storage.folder],
    });
    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: 'b.webm' }]);
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
    await settle();
    h.ui.choose('Second Course');
    await picking;
    h.player.ready();

    expect(await h.listFiles(learning)).toEqual(before);
  });

  it('lists a Course once when one Courses root is inside another', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React Basics/01 Hello.webm': 'v',
      'Node Course/01 Welcome.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning, join(learning, 'Web')]);

    void h.core.pickCourse();
    await settle();

    expect(rows(h.ui.picker)).toEqual(['Node Course', 'React Basics', 'Add Courses root…']);
  });
});
