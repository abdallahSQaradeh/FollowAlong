import { readFile, rename, rm, writeFile } from 'node:fs/promises';
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

describe('relinking a Resource', () => {
  it('points it at the new file, so it is no longer missing and opens again', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'old/notes.md': '# notes',
      'cheat.md': '# cheat',
    });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'old', 'notes.md'));
    await h.core.attachResource('intro.webm', join(course, 'cheat.md'));
    const before = resourceNamed(h, 'intro.webm', 'notes.md');
    await rename(join(course, 'old', 'notes.md'), join(course, 'moved-notes.md'));
    await h.core.openCourse(course);

    await h.core.relinkResource(before.id, join(course, 'moved-notes.md'));

    // Same Resource, same place in its Lesson, no longer dimmed.
    expect(resourceNodes(h, 'intro.webm')).toEqual([
      {
        kind: 'resource',
        id: before.id,
        label: 'moved-notes.md',
        path: join(course, 'moved-notes.md'),
        missing: false,
      },
      expect.objectContaining({ label: 'cheat.md', missing: false }),
    ]);
    await h.core.openResource(before.id);
    expect(h.ui.opened).toEqual([{ kind: 'markdown', path: join(course, 'moved-notes.md') }]);
    expect(h.ui.messages).toEqual([]);
    await h.core.openCourse(course);
    expect(resourceNamed(h, 'intro.webm', 'moved-notes.md').missing).toBe(false);
  });

  it('stores the new file relative to the Course when it is inside it, else by its full path', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes.md': '#' });
    const elsewhere = await h.folder('Elsewhere', { 'snippet.ts': 'export {};', 'inside.md': '#' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    const id = resourceNamed(h, 'intro.webm', 'notes.md').id;

    await h.core.relinkResource(id, join(elsewhere, 'snippet.ts'));
    expect(await storedResources(course)).toMatchObject({
      lessons: { 'intro.webm': [{ id, path: join(elsewhere, 'snippet.ts'), relative: false }] },
    });

    await h.core.relinkResource(id, join(course, 'notes.md'));
    expect(await storedResources(course)).toMatchObject({
      lessons: { 'intro.webm': [{ id, path: 'notes.md', relative: true }] },
    });
  });

  it('asks for the new file in a dialog, and relinks the Resource to what is picked', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'notes.md': '#',
      'new.md': '#',
    });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    const id = resourceNamed(h, 'intro.webm', 'notes.md').id;

    const relinked = h.core.relinkResource(id);
    expect(h.ui.fileDialogRequests.at(-1)).toEqual({
      title: 'Relink “notes.md” to another file',
      openLabel: 'Relink',
    });
    h.ui.answerFileDialog(join(course, 'new.md'));
    await relinked;

    expect(resourceNodes(h, 'intro.webm').map((resource) => resource.label)).toEqual(['new.md']);
  });

  it('changes nothing when the learner closes the dialog without a file', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes.md': '#' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    const id = resourceNamed(h, 'intro.webm', 'notes.md').id;

    const relinked = h.core.relinkResource(id);
    h.ui.answerFileDialog(undefined);
    await relinked;

    expect(resourceNodes(h, 'intro.webm').map((resource) => resource.label)).toEqual(['notes.md']);
    expect(h.ui.messages).toEqual([]);
  });

  it('relinks the Resource of the Course it was asked in, if another Course opens meanwhile', async () => {
    const h = await createHarness();
    const first = await h.folder('First', { '01 One.webm': 'v', 'notes.md': '#', 'new.md': '#' });
    const other = await h.folder('Other', { '01 One.webm': 'v' });
    await h.core.openCourse(first);
    await h.core.attachResource('01 One.webm', join(first, 'notes.md'));
    const id = resourceNamed(h, '01 One.webm', 'notes.md').id;

    const relinked = h.core.relinkResource(id);
    await h.core.openCourse(other);
    h.ui.answerFileDialog(join(first, 'new.md'));
    await relinked;

    expect(resourceNodes(h, '01 One.webm')).toEqual([]);
    expect(h.ui.messages).toContainEqual({
      severity: 'info',
      text: 'FollowAlong relinked “notes.md” to “new.md” in “First”, which is no longer open.',
    });
    await h.core.openCourse(first);
    expect(resourceNodes(h, '01 One.webm').map((resource) => resource.label)).toEqual(['new.md']);
  });

  it('opens no dialog for a Resource the open Course does not have, or with no Course open', async () => {
    const h = await createHarness();
    await h.core.relinkResource('no-such-resource');
    const course = await h.folder('Course', { 'intro.webm': 'video' });
    await h.core.openCourse(course);

    await h.core.relinkResource('no-such-resource');

    expect(h.ui.fileDialogs).toBe(0);
    expect(await h.listFiles(course)).toEqual(['intro.webm']);
  });
});
