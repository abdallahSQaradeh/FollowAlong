import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness } from './harness.js';

/** The tree as the learner reads it: Lessons by their titles, Sections as `label: [children]`. */
function outline(nodes: readonly LessonTreeNode[] | undefined): unknown[] {
  return (nodes ?? []).map((node) =>
    node.kind === 'section' ? { [node.label]: outline(node.children) } : node.label,
  );
}

describe('the Lesson tree of an opened Course', () => {
  it('lists every .mp4 and .webm Lesson, titled by its cleaned file name', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.mp4': 'v', 'setup.webm': 'v' });

    await h.core.openCourse(course);

    expect(h.ui.lessonTree?.nodes.map((node) => node.label)).toEqual(['intro', 'setup']);
  });

  it('shows a subfolder that holds videos as a Section', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Section 1/01 Welcome.webm': 'v',
      'Section 1/02 Setup.mp4': 'v',
      'Section 2/03 Tools.mp4': 'v',
    });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([
      { 'Section 1': ['Welcome', 'Setup'] },
      { 'Section 2': ['Tools'] },
    ]);
  });

  it('puts Lessons and Sections in natural order, so lesson2 comes before lesson10', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'lesson10.mp4': 'v',
      'lesson2.mp4': 'v',
      'lesson1.mp4': 'v',
      'Section 10/a.mp4': 'v',
      'Section 9/a.mp4': 'v',
      'Section 9/part 12.webm': 'v',
      'Section 9/part 3.webm': 'v',
    });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([
      'lesson1',
      'lesson2',
      'lesson10',
      { 'Section 9': ['a', 'part 3', 'part 12'] },
      { 'Section 10': ['a'] },
    ]);
  });

  it('shows Sections inside Sections, however deep the videos are', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Group A/Section 1/deep/er/still/lesson.mp4': 'v',
      'Group A/Section 1/deep/er/other.mp4': 'v',
      'Group A/Section 1/one.mp4': 'v',
      'Group A/Section 2/two.webm': 'v',
      'Group B/three.mp4': 'v',
    });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([
      {
        'Group A': [
          {
            'Section 1': ['one', { deep: ['other', { still: ['lesson'] }] }],
          },
          { 'Section 2': ['two'] },
        ],
      },
      { 'Group B': ['three'] },
    ]);
  });

  it('collapses single-child wrapper folders, keeping the outermost name for a Section', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'udemy-ajconfeb/JavaScript The Advanced Concepts/Section 1/a.mp4': 'v',
      'udemy-ajconfeb/JavaScript The Advanced Concepts/Section 2/Videos/b.mp4': 'v',
      'udemy-ajconfeb/JavaScript The Advanced Concepts/Section 2/Videos/c.mp4': 'v',
      'udemy-ajconfeb/JavaScript The Advanced Concepts/Section 3/Extra/Inner/d.mp4': 'v',
      'udemy-ajconfeb/JavaScript The Advanced Concepts/Section 3/e.mp4': 'v',
    });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([
      { 'Section 1': ['a'] },
      { 'Section 2': ['b', 'c'] },
      { 'Section 3': ['e', { Extra: ['d'] }] },
    ]);
  });

  it('shows the Lessons directly when the only subfolder is a wrapper around them', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'wrapper/one.mp4': 'v', 'wrapper/two.mp4': 'v' });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual(['one', 'two']);
  });

  it('does not collapse a folder that holds Lessons of its own', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'Intro/a.mp4': 'v', 'top.mp4': 'v' });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual(['top', { Intro: ['a'] }]);
  });

  it('leaves out files that are not videos, and folders that hold none', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'lesson.mp4': 'v',
      'slides.pdf': 'x',
      'page.html': 'x',
      'lesson.srt': 'x',
      'notes.txt': 'Some notes\nand more notes\n',
      'code.zip': 'x',
      'Resources/handout.pdf': 'x',
      'Resources/links.html': 'x',
    });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual(['lesson']);
  });

  it('matches the .mp4 and .webm extensions in any letter case', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'A.MP4': 'v', 'B.WebM': 'v', 'C.mp4.srt': 'x' });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual(['A', 'B']);
  });

  it("never lists FollowAlong's own .followalong folder, nor other hidden folders", async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'lesson.mp4': 'v',
      '.followalong/lesson.mp3.webm': 'v',
      '.followalong/cached/clip.mp4': 'v',
      '.git/objects/x.mp4': 'v',
      'node_modules/pkg/demo.mp4': 'v',
    });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual(['lesson']);
  });

  it('plays a Lesson when the learner clicks it in the tree', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Section 1/01 Welcome.webm': 'v',
      'Section 2/02 Tools.mp4': 'v',
      'Section 2/03 Setup.webm': 'v',
    });
    await h.core.openCourse(course);
    h.player.ready();

    h.core.playLesson('Section 2/03 Setup.webm');

    expect(h.player.shown.at(-1)).toEqual({
      title: 'Setup',
      resourceRoots: [course, h.storage.folder],
    });
    expect(h.player.sent.at(-1)).toEqual({
      type: 'load',
      lessonId: 'Section 2/03 Setup.webm',
      videoUri: h.player.resourceUri(join(course, 'Section 2', '03 Setup.webm')),
      container: 'webm',
      startAt: 0,
      autoplay: true,
      loadId: 2,
    });
  });

  it('loads an MP4 Lesson as an MP4, with no sidecar sound yet', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 Intro.mp4': 'v', '02 Next.webm': 'v' });
    await h.core.openCourse(course);
    h.player.ready();

    expect(h.player.sent).toEqual([
      {
        type: 'load',
        lessonId: '01 Intro.mp4',
        videoUri: h.player.resourceUri(join(course, '01 Intro.mp4')),
        container: 'mp4',
        startAt: 0,
        autoplay: true,
        loadId: 1,
      },
    ]);
  });

  it('plays the first Lesson in tree order: Lessons of a folder before its Sections', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'A Section/first.mp4': 'v',
      'top 10.mp4': 'v',
      'top 2.mp4': 'v',
    });

    await h.core.openCourse(course);
    h.player.ready();

    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: 'top 2.mp4' }]);
  });

  it('ignores a click on something that is not a Lesson of the open Course', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'a.mp4': 'v', 'Section/b.mp4': 'v' });
    await h.core.openCourse(course);
    h.player.ready();

    h.core.playLesson('Section/');
    h.core.playLesson('gone.mp4');

    expect(h.player.sent).toHaveLength(1);
  });

  it('shows the tree of the Course opened last', async () => {
    const h = await createHarness();
    const first = await h.folder('first', { 'a.mp4': 'v' });
    const second = await h.folder('second', { 'One/b.webm': 'v', 'Two/c.webm': 'v' });

    await h.core.openCourse(first);
    await h.core.openCourse(second);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([{ One: ['b'] }, { Two: ['c'] }]);
  });

  it('skips a folder it may not read, logs it, and shows the rest of the Course', async () => {
    const h = await createHarness();
    const course = await h.folder('Drive', {
      'Videos/one.mp4': 'v',
      'Videos/two.mp4': 'v',
      'System Volume Information/secret.mp4': 'v',
      'Other/three.webm': 'v',
    });
    const locked = join(course, 'System Volume Information');
    h.makeUnreadable(locked);

    await h.core.openCourse(course);
    h.player.ready();

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([
      { Other: ['three'] },
      { Videos: ['one', 'two'] },
    ]);
    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: 'Other/three.webm' }]);
    expect(h.ui.messages).toEqual([]);
    const skipped = h.logger.entries.filter((entry) => entry.message.includes(locked));
    expect(skipped).toMatchObject([{ level: 'warn' }]);
  });

  it('skips an unreadable folder at any depth', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Section 1/a.mp4': 'v',
      'Section 1/private/x.mp4': 'v',
      'Section 2/b.mp4': 'v',
    });
    h.makeUnreadable(join(course, 'Section 1', 'private'));

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([
      { 'Section 1': ['a'] },
      { 'Section 2': ['b'] },
    ]);
  });
});
