import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness } from './harness.js';

/** The tree as the learner reads it: Lessons by label, Sections as `label: [children]`. */
function outline(nodes: readonly LessonTreeNode[] | undefined): unknown[] {
  return (nodes ?? []).map((node) =>
    node.kind === 'section' ? { [node.label]: outline(node.children) } : node.label,
  );
}

describe('the Lesson tree of an opened Course', () => {
  it('lists every .mp4 and .webm Lesson, titled by its file name', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.mp4': 'v', 'setup.webm': 'v' });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual(['intro', 'setup']);
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
      { 'Section 1': ['01 Welcome', '02 Setup'] },
      { 'Section 2': ['03 Tools'] },
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
      'Part A/Chapter 1/deep/er/still/lesson.mp4': 'v',
      'Part A/Chapter 1/deep/er/other.mp4': 'v',
      'Part A/Chapter 1/one.mp4': 'v',
      'Part A/Chapter 2/two.webm': 'v',
      'Part B/three.mp4': 'v',
    });

    await h.core.openCourse(course);

    expect(outline(h.ui.lessonTree?.nodes)).toEqual([
      {
        'Part A': [
          {
            'Chapter 1': ['one', { deep: ['other', { still: ['lesson'] }] }],
          },
          { 'Chapter 2': ['two'] },
        ],
      },
      { 'Part B': ['three'] },
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
      'notes.txt': 'x',
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
});
