import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode, ResourceNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';

/** The Resources the tree shows under a Lesson. */
function lessonResources(h: Harness, lessonId: string): ResourceNode[] {
  const found: ResourceNode[] = [];
  const walk = (nodes: readonly LessonTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'section') {
        walk(node.children);
      } else if (node.kind === 'lesson' && node.id === lessonId) {
        found.push(...node.resources);
      }
    }
  };
  walk(h.ui.lessonTree?.nodes ?? []);
  return found;
}

function courseResources(h: Harness): ResourceNode[] {
  return [...(h.ui.lessonTree?.course?.resources ?? [])];
}

/** The learner picks “URL…” in the attach choice, and types `url` in the box that follows. */
async function typeUrl(h: Harness, attaching: Promise<void>, url: string | undefined) {
  await h.ui.pickerShown();
  h.ui.choose('URL…');
  await h.ui.textPromptShown();
  h.ui.answerText(url);
  await attaching;
}

async function courseWithLesson(): Promise<{ h: Harness; course: string }> {
  const h = await createHarness();
  const course = await h.folder('Course', { '01 One.webm': 'v', '02 Two.webm': 'v' });
  await h.core.openCourse(course);
  return { h, course };
}

describe('attaching a URL Resource to a Lesson', () => {
  it('offers “URL…” next to “File…” when the learner attaches', async () => {
    const { h } = await courseWithLesson();

    const attaching = h.core.attachResource('01 One.webm');
    await h.ui.pickerShown();

    const labels = h.ui.picker?.entries.flatMap((entry) =>
      entry.kind === 'item' ? [entry.label] : [],
    );
    expect(labels).toEqual(['File…', 'URL…']);
    h.ui.dismissPicker();
    await attaching;
  });

  it('shows the URL under its Lesson, as a Resource that is not a file', async () => {
    const { h } = await courseWithLesson();

    await typeUrl(
      h,
      h.core.attachResource('01 One.webm'),
      'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
    );

    expect(lessonResources(h, '01 One.webm')).toMatchObject([
      {
        kind: 'resource',
        type: 'url',
        label: 'developer.mozilla.org/en-US/docs/Web/JavaScript',
        path: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
        missing: false,
      },
    ]);
    expect(lessonResources(h, '02 Two.webm')).toEqual([]);
  });

  it('keeps the URL in the Resources file, as a reference with no copy', async () => {
    const { h, course } = await courseWithLesson();

    await typeUrl(h, h.core.attachResource('01 One.webm'), 'https://example.com/a');

    const file = JSON.parse(
      await readFile(join(course, '.followalong', 'resources.json'), 'utf8'),
    ) as { data: { lessons: Record<string, unknown[]> } };
    expect(file.data.lessons['01 One.webm']).toMatchObject([
      { kind: 'url', url: 'https://example.com/a' },
    ]);
  });

  it('attaches nothing when the learner closes the choice or the box', async () => {
    const { h } = await courseWithLesson();

    const closedChoice = h.core.attachResource('01 One.webm');
    await h.ui.pickerShown();
    h.ui.dismissPicker();
    await closedChoice;
    await typeUrl(h, h.core.attachResource('01 One.webm'), undefined);

    expect(lessonResources(h, '01 One.webm')).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });

  it('asks for a file as before when the learner picks “File…”', async () => {
    const { h, course } = await courseWithLesson();
    await writeFile(join(course, 'notes.md'), '# notes');

    h.ui.willChoose('File…');
    const attaching = h.core.attachResource('01 One.webm');
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(join(course, 'notes.md'));
    await attaching;

    expect(lessonResources(h, '01 One.webm').map((resource) => resource.label)).toEqual([
      'notes.md',
    ]);
  });
});

describe('attaching a URL Resource to the whole Course', () => {
  it('shows the URL on the Course node, through the same choice', async () => {
    const { h } = await courseWithLesson();

    await typeUrl(h, h.core.attachCourseResource(), 'https://example.com/cheat-sheet');

    expect(courseResources(h)).toMatchObject([
      { type: 'url', label: 'example.com/cheat-sheet', path: 'https://example.com/cheat-sheet' },
    ]);
    expect(lessonResources(h, '01 One.webm')).toEqual([]);
  });
});
