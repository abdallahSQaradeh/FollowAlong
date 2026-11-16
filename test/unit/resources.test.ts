import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createFollowAlong } from '../../src/core/follow-along.js';
import type { UserMessage } from '../../src/core/ports.js';
import { createHarness, type Harness } from './harness.js';
import { makeReadOnly } from './read-only.js';

/** The Lesson with this id, wherever it sits in the tree the learner sees. */
function lessonNode(h: Harness, lessonId: string): LessonTreeNode | undefined {
  const find = (nodes: readonly LessonTreeNode[]): LessonTreeNode | undefined => {
    for (const node of nodes) {
      if (node.kind === 'lesson' && node.id === lessonId) {
        return node;
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
  return find(h.ui.lessonTree?.nodes ?? []);
}

/** The labels of the Resources shown under a Lesson. */
function resourceLabels(h: Harness, lessonId: string): string[] {
  const node = lessonNode(h, lessonId);
  if (node?.kind !== 'lesson') {
    throw new Error(`The tree shows no Lesson ${lessonId}`);
  }
  return node.resources.map((resource) => resource.label);
}

/** The id of the first Resource shown under a Lesson. */
function firstResourceId(h: Harness, lessonId: string): string {
  const node = lessonNode(h, lessonId);
  const resource = node?.kind === 'lesson' ? node.resources[0] : undefined;
  if (resource === undefined) {
    throw new Error(`${lessonId} shows no Resource`);
  }
  return resource.id;
}

/** What is stored in the Resources file of a Course, as JSON. */
async function storedResources(course: string): Promise<unknown> {
  const stored: unknown = JSON.parse(
    await readFile(join(course, '.followalong', 'resources.json'), 'utf8'),
  );
  return stored;
}

describe('attaching a file Resource to a Lesson', () => {
  it('shows the file under its Lesson in the tree', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'Section 1/01 Welcome.webm': 'video',
      'Section 1/02 Setup.webm': 'video',
      'Section 1/notes/cheat sheet.md': '# cheat sheet',
    });
    await h.core.openCourse(course);

    await h.core.attachResource(
      'Section 1/01 Welcome.webm',
      join(course, 'Section 1', 'notes', 'cheat sheet.md'),
    );

    expect(resourceLabels(h, 'Section 1/01 Welcome.webm')).toEqual(['cheat sheet.md']);
    expect(resourceLabels(h, 'Section 1/02 Setup.webm')).toEqual([]);
  });

  it('stores a reference in a versioned JSON Resources file, and copies nothing', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'notes/cheat sheet.md': '# cheat sheet',
    });
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', join(course, 'notes', 'cheat sheet.md'));

    expect(await storedResources(course)).toEqual({
      version: 1,
      data: {
        course: [],
        lessons: {
          'intro.webm': [
            {
              id: firstResourceId(h, 'intro.webm'),
              kind: 'file',
              path: 'notes/cheat sheet.md',
              relative: true,
            },
          ],
        },
      },
    });
    expect(await h.listFiles(course)).toEqual([
      '.followalong/resources.json',
      'intro.webm',
      'notes/cheat sheet.md',
    ]);
    expect(h.ui.messages).toEqual([]);
  });

  it('stores a file outside the Course by its absolute path, and copies nothing', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video' });
    const elsewhere = await h.folder('Elsewhere', { 'snippet.ts': 'export {};' });
    const snippet = join(elsewhere, 'snippet.ts');
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', snippet);

    expect(await storedResources(course)).toMatchObject({
      data: { lessons: { 'intro.webm': [{ path: snippet, relative: false }] } },
    });
    expect(await h.listFiles(course)).toEqual(['.followalong/resources.json', 'intro.webm']);
    expect(await h.listFiles(elsewhere)).toEqual(['snippet.ts']);
  });

  it('treats a file next to the Course, not inside it, as outside', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video' });
    const sibling = await h.folder('Course notes', { 'notes.md': '# notes' });
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', join(sibling, 'notes.md'));

    expect(await storedResources(course)).toMatchObject({
      data: { lessons: { 'intro.webm': [{ path: join(sibling, 'notes.md'), relative: false }] } },
    });
  });

  it('keeps the Resource when the Course is opened again', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes.md': '# notes' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));

    // A later session: a new core, reading what the first one wrote.
    const later = createFollowAlong(h.ports);
    await later.openCourse(course);
    later.dispose();

    expect(resourceLabels(h, 'intro.webm')).toEqual(['notes.md']);
  });

  it('keeps a file inside the Course reachable after the Course is moved', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes/cheat.md': '#' });
    const outside = await h.folder('Elsewhere', { 'snippet.ts': 'export {};' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes', 'cheat.md'));
    await h.core.attachResource('intro.webm', join(outside, 'snippet.ts'));

    const moved = join(h.root, 'Moved', 'Course renamed');
    await h.folder('Moved', {});
    await rename(course, moved);
    await h.core.openCourse(moved);
    const node = lessonNode(h, 'intro.webm');
    const ids = node?.kind === 'lesson' ? node.resources.map((resource) => resource.id) : [];
    for (const id of ids) {
      await h.core.openResource(id);
    }

    expect(h.ui.opened).toEqual([
      { kind: 'markdown', path: join(moved, 'notes', 'cheat.md') },
      { kind: 'file', path: join(outside, 'snippet.ts') },
    ]);
  });

  it('keeps the Resources of a Lesson in the order they were attached, each Lesson its own', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'one.webm': 'video',
      'two.webm': 'video',
      'b.md': '#',
      'a.md': '#',
    });
    await h.core.openCourse(course);

    await h.core.attachResource('one.webm', join(course, 'b.md'));
    await h.core.attachResource('one.webm', join(course, 'a.md'));
    await h.core.attachResource('two.webm', join(course, 'a.md'));

    expect(resourceLabels(h, 'one.webm')).toEqual(['b.md', 'a.md']);
    expect(resourceLabels(h, 'two.webm')).toEqual(['a.md']);
  });

  it('keeps what is attached to the whole Course when a Lesson gets a Resource', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'a.md': '#',
      '.followalong/resources.json': JSON.stringify({
        version: 1,
        data: {
          course: [{ id: 'cheat', kind: 'file', path: 'cheat.md', relative: true }],
          lessons: {},
        },
      }),
    });
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', join(course, 'a.md'));

    expect(await storedResources(course)).toMatchObject({
      data: { course: [{ id: 'cheat', path: 'cheat.md' }] },
    });
  });

  it('reads a Resources file written before the Course key existed', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'a.md': '#',
      '.followalong/resources.json': JSON.stringify({
        version: 1,
        data: {
          lessons: { 'intro.webm': [{ id: 'x', kind: 'file', path: 'a.md', relative: true }] },
        },
      }),
    });

    await h.core.openCourse(course);

    expect(resourceLabels(h, 'intro.webm')).toEqual(['a.md']);
  });

  it('keeps both Resources when two are attached at once', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'a.md': '#', 'b.md': '#' });
    await h.core.openCourse(course);

    await Promise.all([
      h.core.attachResource('intro.webm', join(course, 'a.md')),
      h.core.attachResource('intro.webm', join(course, 'b.md')),
    ]);

    expect(resourceLabels(h, 'intro.webm')).toEqual(['a.md', 'b.md']);
    expect(await storedResources(course)).toMatchObject({
      data: { lessons: { 'intro.webm': [{ path: 'a.md' }, { path: 'b.md' }] } },
    });
  });

  it('keeps what another window attached to the same Course meanwhile', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'a.md': '#', 'b.md': '#' });
    await h.core.openCourse(course);
    const other = createFollowAlong(h.ports);
    await other.openCourse(course);

    await other.attachResource('intro.webm', join(course, 'a.md'));
    await h.core.attachResource('intro.webm', join(course, 'b.md'));
    other.dispose();

    expect(resourceLabels(h, 'intro.webm')).toEqual(['a.md', 'b.md']);
  });

  it('falls back to the extension storage, without an error, when the Course is read-only', async () => {
    const h = await createHarness();
    const course = await h.folder('Read-only course', { 'intro.webm': 'video', 'a.md': '#' });
    makeReadOnly(course);
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', join(course, 'a.md'));

    expect(await h.listFiles(course)).toEqual(['a.md', 'intro.webm']);
    expect(await h.listFiles(h.storage.folder)).toEqual([
      expect.stringMatching(/^courses\/Read-only course-[0-9a-f]{16}\/resources\.json$/),
    ]);
    expect(resourceLabels(h, 'intro.webm')).toEqual(['a.md']);
    expect(h.ui.messages).toEqual([]);
  });

  it('attaches nothing to a Lesson the open Course does not have', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'a.md': '#' });
    await h.core.openCourse(course);

    await h.core.attachResource('missing.webm', join(course, 'a.md'));

    expect(await h.listFiles(course)).toEqual(['a.md', 'intro.webm']);
    expect(resourceLabels(h, 'intro.webm')).toEqual([]);
  });

  const cannotUpdate: UserMessage = {
    severity: 'warning',
    text: "FollowAlong can't update the Resources file of “Course” (it is damaged or from a newer version). Nothing was changed.",
  };

  it('opens the Course without Resources when the Resources file is damaged', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      '.followalong/resources.json': '{"version": 1, "data": ',
    });

    await h.core.openCourse(course);

    expect(resourceLabels(h, 'intro.webm')).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });

  it('attaches nothing, and says so, when the Resources file is damaged', async () => {
    const h = await createHarness();
    const damaged = '{"version": 1, "data": ';
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'a.md': '#',
      '.followalong/resources.json': damaged,
    });
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', join(course, 'a.md'));

    expect(await readFile(join(course, '.followalong', 'resources.json'), 'utf8')).toBe(damaged);
    expect(resourceLabels(h, 'intro.webm')).toEqual([]);
    expect(h.ui.messages).toEqual([cannotUpdate]);
  });

  it('attaches nothing, and says so, when the Resources file is from a newer FollowAlong', async () => {
    const h = await createHarness();
    const newer = JSON.stringify({ version: 9, data: { lessons: { 'intro.webm': ['future'] } } });
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'a.md': '#',
      '.followalong/resources.json': newer,
    });
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', join(course, 'a.md'));

    expect(await readFile(join(course, '.followalong', 'resources.json'), 'utf8')).toBe(newer);
    expect(resourceLabels(h, 'intro.webm')).toEqual([]);
    expect(h.ui.messages).toEqual([cannotUpdate]);
  });
});

describe('attaching from the tree’s “+” without a file yet', () => {
  it('asks for a file and attaches it to the Lesson the “+” belongs to', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v', 'notes.md': '# notes' });
    await h.core.openCourse(course);

    const attached = h.core.attachResource('01 One.webm');
    expect(h.ui.fileDialogOpen).toBe(true);
    h.ui.answerFileDialog(join(course, 'notes.md'));
    await attached;

    expect(resourceLabels(h, '01 One.webm')).toEqual(['notes.md']);
  });

  it('attaches to the Lesson of the Course it was clicked in, if another Course opens meanwhile', async () => {
    const h = await createHarness();
    const first = await h.folder('First', { '01 One.webm': 'v', 'notes.md': '# notes' });
    const other = await h.folder('Other', { '01 One.webm': 'v' });
    await h.core.openCourse(first);

    const attached = h.core.attachResource('01 One.webm');
    await h.core.openCourse(other);
    h.ui.answerFileDialog(join(first, 'notes.md'));
    await attached;

    expect(resourceLabels(h, '01 One.webm')).toEqual([]);
    expect(h.ui.messages).toContainEqual({
      severity: 'info',
      text: 'FollowAlong attached “notes.md” to “One” in “First”, which is no longer open.',
    });
    await h.core.openCourse(first);
    expect(resourceLabels(h, '01 One.webm')).toEqual(['notes.md']);
  });

  it('writes nothing when the learner closes the dialog without a file', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v', 'notes.md': '# notes' });
    await h.core.openCourse(course);

    const attached = h.core.attachResource('01 One.webm');
    h.ui.answerFileDialog(undefined);
    await attached;

    expect(await h.listFiles(course)).toEqual(['01 One.webm', 'notes.md']);
    expect(resourceLabels(h, '01 One.webm')).toEqual([]);
  });

  it('opens no dialog with no Course open, or for a Lesson the open Course does not have', async () => {
    const h = await createHarness();
    await h.core.attachResource('01 One.webm');
    const course = await h.folder('Course', { '01 One.webm': 'v' });
    await h.core.openCourse(course);
    await h.core.attachResource('missing.webm');

    expect(h.ui.fileDialogs).toBe(0);
    expect(await h.listFiles(course)).toEqual(['01 One.webm']);
  });
});

describe('attaching to a read-only Course whose fallback Resources file cannot be read', () => {
  it('attaches nothing, and says so, instead of failing the command', async () => {
    const h = await createHarness();
    const course = await h.folder('Read-only course', {
      'intro.webm': 'video',
      'a.md': '#',
      'b.md': '#',
    });
    makeReadOnly(course);
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'a.md'));
    const [fallbackCopy] = await h.listFiles(h.storage.folder);
    const fallback = join(h.storage.folder, fallbackCopy ?? '');
    const newer = JSON.stringify({ version: 9, data: {} });
    await writeFile(fallback, newer);
    h.restart();
    await h.core.openCourse(course);

    await h.core.attachResource('intro.webm', join(course, 'b.md'));

    expect(await readFile(fallback, 'utf8')).toBe(newer);
    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: "FollowAlong can't update the Resources file of “Read-only course” (it is damaged or from a newer version). Nothing was changed.",
      },
    ]);
  });
});

describe('opening a Resource', () => {
  it('opens the file in a tab beside the code and leaves the video alone', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes/cheat.md': '#' });
    await h.core.openCourse(course);
    h.player.ready();
    const shown = [...h.player.shown];
    const sent = [...h.player.sent];
    await h.core.attachResource('intro.webm', join(course, 'notes', 'cheat.md'));

    await h.core.openResource(firstResourceId(h, 'intro.webm'));

    expect(h.ui.opened).toEqual([{ kind: 'markdown', path: join(course, 'notes', 'cheat.md') }]);
    expect(h.player.shown).toEqual(shown);
    expect(h.player.sent).toEqual(sent);
  });

  it.each([
    ['notes.md', 'markdown'],
    ['README.markdown', 'markdown'],
    ['page.html', 'html'],
    ['page.htm', 'html'],
    ['diagram.png', 'image'],
    ['photo.jpg', 'image'],
    ['photo.jpeg', 'image'],
    ['anim.gif', 'image'],
    ['shot.webp', 'image'],
    ['icon.ico', 'image'],
    ['scan.bmp', 'image'],
    ['photo.avif', 'image'],
    ['slides.pdf', 'pdf'],
    ['snippet.ts', 'file'],
    ['notes.txt', 'file'],
    ['logo.svg', 'file'],
    ['Makefile', 'file'],
    ['NOTES.MD', 'markdown'],
    ['Slides.PDF', 'pdf'],
    ['PAGE.HTML', 'html'],
  ])('opens %s as a %s', async (name, kind) => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', [`res/${name}`]: 'content' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'res', name));

    await h.core.openResource(firstResourceId(h, 'intro.webm'));

    expect(h.ui.opened).toEqual([{ kind, path: join(course, 'res', name) }]);
  });

  it('opens a file whose name only ends like a type as a plain file', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      'intro.webm': 'video',
      'res/pdf': 'x',
      'res/.md': 'x',
    });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'res', 'pdf'));
    await h.core.attachResource('intro.webm', join(course, 'res', '.md'));
    const node = lessonNode(h, 'intro.webm');
    const ids = node?.kind === 'lesson' ? node.resources.map((resource) => resource.id) : [];
    for (const id of ids) {
      await h.core.openResource(id);
    }

    expect(h.ui.opened.map((target) => target.kind)).toEqual(['file', 'file']);
  });

  it('opens nothing for a Resource the open Course does not have', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video' });
    await h.core.openCourse(course);

    await h.core.openResource('no-such-resource');

    expect(h.ui.opened).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });

  it('says so when the file is gone, instead of failing silently', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.webm': 'video', 'notes.md': '#' });
    await h.core.openCourse(course);
    await h.core.attachResource('intro.webm', join(course, 'notes.md'));
    h.ui.openFailure = 'ENOENT: no such file';

    await h.core.openResource(firstResourceId(h, 'intro.webm'));

    expect(h.ui.messages).toEqual([
      {
        severity: 'error',
        text: 'FollowAlong could not open “notes.md”. Is the file still there?',
      },
    ]);
  });
});
