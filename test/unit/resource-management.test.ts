import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode, ResourceNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';

/** The Resources shown under a Lesson, as the learner sees them in the tree. */
function resourceNodes(h: Harness, lessonId: string): readonly ResourceNode[] {
  const find = (nodes: readonly LessonTreeNode[]): readonly ResourceNode[] | undefined => {
    for (const node of nodes) {
      if (node.kind === 'lesson' && node.id === lessonId) {
        return node.resources;
      }
      if (node.kind === 'section') {
        const found = find(node.children);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  const nodes = find(h.ui.lessonTree?.nodes ?? []);
  if (nodes === undefined) {
    throw new Error(`The tree shows no Lesson ${lessonId}`);
  }
  return nodes;
}

/** The Resource under a Lesson with this label. */
function resourceNamed(h: Harness, lessonId: string, label: string): ResourceNode {
  const node = resourceNodes(h, lessonId).find((resource) => resource.label === label);
  if (node === undefined) {
    throw new Error(`${lessonId} shows no Resource ${label}`);
  }
  return node;
}

describe('a Resource whose file is missing', () => {
  it('shows dimmed in the tree when the Course opens, the others as usual', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'notes.md': '# notes',
      'cheat.md': '# cheat',
    });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    await h.core.attachResource('intro.webm', join(course, 'cheat.md'));
    await rm(join(course, 'notes.md'));

    await h.core.openCourse(course);

    expect(resourceNamed(h, 'intro.webm', 'notes.md').missing).toBe(true);
    expect(resourceNamed(h, 'intro.webm', 'cheat.md').missing).toBe(false);
  });

  it('is dimmed, and opens nothing, when its file goes while the Course is open', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes.md': '# notes' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    await rm(join(course, 'notes.md'));

    await h.core.openResource(resourceNamed(h, 'intro.webm', 'notes.md').id);

    expect(h.ui.opened).toEqual([]);
    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: 'FollowAlong can’t find “notes.md”: it was moved, renamed or deleted. Use Relink… on it in the Lesson tree to point it at the file’s new place.',
      },
    ]);
    expect(resourceNamed(h, 'intro.webm', 'notes.md').missing).toBe(true);
  });

  it('opens again, and is no longer dimmed, when its file comes back', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes.md': '# notes' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    await rm(join(course, 'notes.md'));
    await h.core.openCourse(course);
    await writeFile(join(course, 'notes.md'), '# notes again');

    await h.core.openResource(resourceNamed(h, 'intro.webm', 'notes.md').id);

    expect(h.ui.opened).toEqual([{ kind: 'markdown', path: join(course, 'notes.md') }]);
    expect(resourceNamed(h, 'intro.webm', 'notes.md').missing).toBe(false);
    expect(h.ui.messages).toEqual([]);
  });
});

/** What is stored in the Resources file of a Course, as JSON. */
async function storedResources(course: string): Promise<unknown> {
  const stored = JSON.parse(
    await readFile(join(course, '.followalong', 'resources.json'), 'utf8'),
  ) as { readonly data: unknown };
  return stored.data;
}

describe('detaching a Resource', () => {
  it('removes it from the tree and the Resources file, and leaves the file on disk', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'two.webm': 'video',
      'notes.md': '# notes',
      'cheat.md': '# cheat',
    });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    await h.core.attachResource('intro.webm', join(course, 'cheat.md'));
    await h.core.attachResource('two.webm', join(course, 'notes.md'));

    await h.core.detachResource(resourceNamed(h, 'intro.webm', 'notes.md').id);

    expect(resourceNodes(h, 'intro.webm').map((resource) => resource.label)).toEqual(['cheat.md']);
    expect(resourceNodes(h, 'two.webm').map((resource) => resource.label)).toEqual(['notes.md']);
    expect(await storedResources(course)).toMatchObject({
      lessons: { 'intro.webm': [{ path: 'cheat.md' }], 'two.webm': [{ path: 'notes.md' }] },
    });
    expect(await readFile(join(course, 'notes.md'), 'utf8')).toBe('# notes');
    await h.core.openCourse(course);
    expect(resourceNodes(h, 'intro.webm').map((resource) => resource.label)).toEqual(['cheat.md']);
    expect(h.ui.messages).toEqual([]);
  });

  it('detaches a missing Resource too', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes.md': '# notes' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    await rm(join(course, 'notes.md'));
    await h.core.openCourse(course);

    await h.core.detachResource(resourceNamed(h, 'intro.webm', 'notes.md').id);

    expect(resourceNodes(h, 'intro.webm')).toEqual([]);
  });

  it('does nothing for a Resource the open Course does not have, or with no Course open', async () => {
    const h = await createHarness();
    await h.core.detachResource('no-such-resource');
    const course = await h.folder('Course', { 'intro.webm': 'video' });
    await h.core.openCourse(course);

    await h.core.detachResource('no-such-resource');

    expect(await h.listFiles(course)).toEqual(['intro.webm']);
    expect(h.ui.messages).toEqual([]);
  });
});
