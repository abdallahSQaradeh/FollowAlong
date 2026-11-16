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
});
