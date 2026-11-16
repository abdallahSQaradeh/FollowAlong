import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

/** The labels of the Resources the tree shows on the Course node, which sits at its top. */
function courseLabels(h: Harness): string[] {
  const course = h.ui.lessonTree?.course;
  if (course === undefined) {
    throw new Error('The tree shows no Course node');
  }
  return course.resources.map((resource) => resource.label);
}

/** The Resource on the Course node with this label. */
function courseResource(h: Harness, label: string): { id: string; missing: boolean } {
  const found = h.ui.lessonTree?.course?.resources.find((resource) => resource.label === label);
  if (found === undefined) {
    throw new Error(`The Course node shows no Resource ${label}`);
  }
  return found;
}

describe('attaching a file Resource to the whole Course', () => {
  it('shows the file on the Course node, which has none before', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      '01 One.webm': 'v',
      'Part/02 Two.webm': 'v',
      'cheat.md': '# cheat',
    });
    await h.core.openCourse(course);
    expect(courseLabels(h)).toEqual([]);

    await h.core.attachCourseResource(join(course, 'cheat.md'));

    expect(courseLabels(h)).toEqual(['cheat.md']);
    expect(h.ui.lessonTree?.course?.label).toBe('Course');
  });

  it('shows the Course node first, above the Lessons and Sections, which are unchanged', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      '01 One.webm': 'v',
      'Part/02 Two.webm': 'v',
      'cheat.md': '# cheat',
    });
    await h.core.openCourse(course);
    const before = h.ui.lessonTree?.nodes;

    await h.core.attachCourseResource(join(course, 'cheat.md'));

    expect(h.ui.lessonTree?.nodes).toEqual(before);
    expect(h.ui.lessonTree?.course?.id).not.toMatch(/\.webm$|\/$/);
  });

  it('keeps Course Resources in the order they were attached, apart from the Lessons’', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      '01 One.webm': 'v',
      'b.md': '#',
      'a.md': '#',
      'c.md': '#',
    });
    await h.core.openCourse(course);

    await h.core.attachCourseResource(join(course, 'b.md'));
    await h.core.attachCourseResource(join(course, 'a.md'));
    await h.core.attachResource('01 One.webm', join(course, 'c.md'));

    expect(courseLabels(h)).toEqual(['b.md', 'a.md']);
  });

  it('stores a reference under `course` in the Resources file, and copies nothing', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v', 'docs/cheat.md': '# cheat' });
    const outside = await h.folder('Elsewhere', { 'ref.pdf': 'pdf' });
    await h.core.openCourse(course);

    await h.core.attachCourseResource(join(course, 'docs', 'cheat.md'));
    await h.core.attachCourseResource(join(outside, 'ref.pdf'));

    expect(await stored(course)).toMatchObject({
      version: 1,
      data: {
        course: [
          { kind: 'file', path: 'docs/cheat.md', relative: true },
          { kind: 'file', path: join(outside, 'ref.pdf'), relative: false },
        ],
        lessons: {},
      },
    });
    expect(await h.listFiles(course)).toEqual([
      '.followalong/resources.json',
      '01 One.webm',
      'docs/cheat.md',
    ]);
  });

  it('keeps the Course Resources when the Course is opened again', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v', 'cheat.md': '# cheat' });
    await h.core.openCourse(course);
    await h.core.attachCourseResource(join(course, 'cheat.md'));

    await h.core.openCourse(course);

    expect(courseLabels(h)).toEqual(['cheat.md']);
  });

  it('shows no Course node for a folder with no Lessons, and attaches nothing there', async () => {
    const h = await createHarness();
    const course = await h.folder('Empty', { 'notes.md': '#' });
    await h.core.openCourse(course);

    await h.core.attachCourseResource(join(course, 'notes.md'));

    expect(h.ui.lessonTree?.course).toBeUndefined();
    expect(await h.listFiles(course)).toEqual(['notes.md']);
  });

  it('attaches nothing, and opens no dialog, with no Course open', async () => {
    const h = await createHarness();

    await h.core.attachCourseResource();

    expect(h.ui.fileDialogs).toBe(0);
  });
});

describe('attaching to the Course from the tree’s “+” without a file yet', () => {
  it('asks for a file and attaches it to the Course', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v', 'cheat.md': '# cheat' });
    await h.core.openCourse(course);

    const attached = h.core.attachCourseResource();
    expect(h.ui.fileDialogOpen).toBe(true);
    h.ui.answerFileDialog(join(course, 'cheat.md'));
    await attached;

    expect(courseLabels(h)).toEqual(['cheat.md']);
  });

  it('attaches to the Course it was clicked in, if another Course opens meanwhile', async () => {
    const h = await createHarness();
    const first = await h.folder('First', { '01 One.webm': 'v', 'cheat.md': '# cheat' });
    const other = await h.folder('Other', { '01 One.webm': 'v' });
    await h.core.openCourse(first);

    const attached = h.core.attachCourseResource();
    await h.core.openCourse(other);
    h.ui.answerFileDialog(join(first, 'cheat.md'));
    await attached;

    expect(courseLabels(h)).toEqual([]);
    expect(h.ui.messages).toContainEqual({
      severity: 'info',
      text: 'FollowAlong attached “cheat.md” to the Course in “First”, which is no longer open.',
    });
    await h.core.openCourse(first);
    expect(courseLabels(h)).toEqual(['cheat.md']);
  });

  it('writes nothing when the learner closes the dialog without a file', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v' });
    await h.core.openCourse(course);

    const attached = h.core.attachCourseResource();
    h.ui.answerFileDialog(undefined);
    await attached;

    expect(await h.listFiles(course)).toEqual(['01 One.webm']);
    expect(courseLabels(h)).toEqual([]);
  });
});

describe('a Course Resource, like a Lesson Resource', () => {
  it('opens in a tab beside the code, by its type, and leaves the video alone', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v', 'cheat.md': '# cheat' });
    await h.core.openCourse(course);
    h.player.ready();
    const shown = [...h.player.shown];
    const sent = [...h.player.sent];
    await h.core.attachCourseResource(join(course, 'cheat.md'));

    await h.core.openResource(courseResource(h, 'cheat.md').id);

    expect(h.ui.opened).toEqual([{ kind: 'markdown', path: join(course, 'cheat.md') }]);
    expect(h.player.shown).toEqual(shown);
    expect(h.player.sent).toEqual(sent);
  });

  it('is dimmed, and opens nothing, when its file goes; Relink points it at another file', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', {
      '01 One.webm': 'v',
      'cheat.md': '# cheat',
      'new.md': '# new',
    });
    await h.core.openCourse(course);
    await h.core.attachCourseResource(join(course, 'cheat.md'));
    const { id } = courseResource(h, 'cheat.md');
    await rm(join(course, 'cheat.md'));

    await h.core.openResource(id);
    expect(h.ui.opened).toEqual([]);
    expect(courseResource(h, 'cheat.md').missing).toBe(true);

    await h.core.relinkResource(id, join(course, 'new.md'));
    expect(courseLabels(h)).toEqual(['new.md']);
    expect(courseResource(h, 'new.md')).toMatchObject({ id, missing: false });
  });

  it('detaches, and the file stays on disk', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { '01 One.webm': 'v', 'cheat.md': '# cheat' });
    await h.core.openCourse(course);
    await h.core.attachCourseResource(join(course, 'cheat.md'));

    await h.core.detachResource(courseResource(h, 'cheat.md').id);

    expect(courseLabels(h)).toEqual([]);
    expect(await h.listFiles(course)).toContain('cheat.md');
  });
});

/** What is stored in the Resources file of a Course, as JSON. */
async function stored(course: string): Promise<unknown> {
  const text = await readFile(join(course, '.followalong', 'resources.json'), 'utf8');
  return JSON.parse(text) as unknown;
}
