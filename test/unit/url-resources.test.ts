import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

function messageTexts(h: Harness): string[] {
  return h.ui.messages.map((message) => message.text);
}

function severities(h: Harness): string[] {
  return h.ui.messages.map((message) => message.severity);
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

/** What the box shows under the text, as the learner types it in the URL prompt. */
async function problemWith(text: string): Promise<string | undefined> {
  const { h } = await courseWithLesson();
  h.ui.willChoose('URL…');
  const attaching = h.core.attachResource('01 One.webm');
  await h.ui.textPromptShown();
  const problem = h.ui.textPrompt?.validate(text);
  h.ui.answerText(undefined);
  await attaching;
  return problem;
}

describe('checking the URL the learner types', () => {
  it.each([
    'https://example.com',
    'http://localhost:3000/docs?x=1#top',
    '  https://example.com/a  ',
    'HTTPS://EXAMPLE.COM/A',
  ])('accepts %j', async (text) => {
    expect(await problemWith(text)).toBeUndefined();
  });

  it.each([
    ['file:///etc/passwd', 'file:'],
    ['command:workbench.action.reloadWindow', 'command:'],
    ['vscode://file/etc/passwd', 'vscode:'],
    ['vscode-remote://ssh-remote+host/x', 'vscode-remote:'],
    ['javascript:alert(1)', 'javascript:'],
    ['JavaScript:alert(1)', 'javascript:'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['ftp://example.com/file', 'ftp:'],
    ['mailto:someone@example.com', 'mailto:'],
  ])('refuses %j, saying that only http:// and https:// can be attached', async (text, scheme) => {
    const problem = await problemWith(text);

    expect(problem).toContain('Only http:// and https://');
    expect(problem).toContain(scheme);
  });

  it.each(['', '   ', 'example.com', 'not a url', 'https://'])(
    'asks for a web address when given %j',
    async (text) => {
      expect(await problemWith(text)).toMatch(/web address|address of a web page/);
    },
  );

  it('attaches nothing, and says why, if a refused URL is confirmed anyway', async () => {
    const { h, course } = await courseWithLesson();

    await typeUrl(h, h.core.attachResource('01 One.webm'), 'javascript:alert(1)');

    expect(lessonResources(h, '01 One.webm')).toEqual([]);
    expect(severities(h)).toEqual(['warning']);
    expect(messageTexts(h)[0]).toContain('javascript:');
    await expect(
      readFile(join(course, '.followalong', 'resources.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('keeps the address in its normal form, without the spaces around it', async () => {
    const { h } = await courseWithLesson();

    await typeUrl(h, h.core.attachResource('01 One.webm'), '  HTTPS://Example.com/Docs  ');

    expect(lessonResources(h, '01 One.webm')).toMatchObject([
      { path: 'https://example.com/Docs', label: 'example.com/Docs' },
    ]);
  });
});

/** Writes a Resources file the learner did not make through FollowAlong (or a hostile one). */
async function withStoredUrls(
  urls: Record<string, string>,
): Promise<{ h: Harness; course: string }> {
  const h = await createHarness();
  const course = await h.folder('Course', { '01 One.webm': 'v' });
  await mkdir(join(course, '.followalong'), { recursive: true });
  const lessons = Object.entries(urls).map(([id, url]) => ({ id, kind: 'url', url }));
  await writeFile(
    join(course, '.followalong', 'resources.json'),
    JSON.stringify({ version: 1, data: { course: [], lessons: { '01 One.webm': lessons } } }),
  );
  await h.core.openCourse(course);
  return { h, course };
}

describe('opening a URL Resource', () => {
  it('opens a web page in Simple Browser, and nothing else', async () => {
    const { h } = await courseWithLesson();
    await typeUrl(h, h.core.attachResource('01 One.webm'), 'https://example.com/docs');
    const sent = h.player.sent.length;

    await h.core.openResource(lessonResources(h, '01 One.webm')[0]?.id ?? '');

    expect(h.ui.opened).toEqual([{ kind: 'url', url: 'https://example.com/docs' }]);
    expect(h.player.sent).toHaveLength(sent);
    expect(h.ui.messages).toEqual([]);
  });

  it('opens an http page too', async () => {
    const { h } = await withStoredUrls({ a: 'http://localhost:8080/x' });

    await h.core.openResource('a');

    expect(h.ui.opened).toEqual([{ kind: 'url', url: 'http://localhost:8080/x' }]);
  });

  it.each([
    'file:///etc/passwd',
    'command:workbench.action.reloadWindow',
    'vscode://vscode.git/clone?url=https://evil.example/x.git',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'not a url at all',
    '',
  ])('refuses to open a stored %j, which no attach could have made', async (stored) => {
    const { h } = await withStoredUrls({ a: stored });

    await h.core.openResource('a');

    expect(h.ui.opened).toEqual([]);
    expect(severities(h)).toEqual(['warning']);
    expect(messageTexts(h)[0]).toContain('Detach');
  });

  it('shows a stored URL it will not open, so the learner can detach it', async () => {
    const { h } = await withStoredUrls({ a: 'javascript:alert(1)' });

    expect(lessonResources(h, '01 One.webm')).toMatchObject([
      { id: 'a', type: 'url', missing: false },
    ]);
    await h.core.detachResource('a');
    expect(lessonResources(h, '01 One.webm')).toEqual([]);
  });

  it('tells the learner when Simple Browser cannot open the page', async () => {
    const { h } = await withStoredUrls({ a: 'https://example.com/x' });
    h.ui.openFailure = 'Simple Browser is disabled';

    await h.core.openResource('a');

    expect(severities(h)).toEqual(['error']);
    expect(messageTexts(h)[0]).toContain('example.com/x');
  });
});

describe('managing a URL Resource', () => {
  it('detaches it: the reference goes and the Resources file keeps no trace of it', async () => {
    const { h, course } = await courseWithLesson();
    await typeUrl(h, h.core.attachResource('01 One.webm'), 'https://example.com/a');
    await typeUrl(h, h.core.attachResource('01 One.webm'), 'https://example.com/b');
    const [first] = lessonResources(h, '01 One.webm');

    await h.core.detachResource(first?.id ?? '');

    expect(lessonResources(h, '01 One.webm').map((resource) => resource.label)).toEqual([
      'example.com/b',
    ]);
    const stored = await readFile(join(course, '.followalong', 'resources.json'), 'utf8');
    expect(stored).not.toContain('example.com/a');
  });

  it('is never missing, and Relink explains that a URL has no file', async () => {
    const { h } = await courseWithLesson();
    await typeUrl(h, h.core.attachResource('01 One.webm'), 'https://example.com/a');
    const id = lessonResources(h, '01 One.webm')[0]?.id ?? '';

    await h.core.relinkResource(id, join(h.root, 'elsewhere.md'));
    await h.core.openCourse(join(h.root, 'Course'));

    expect(severities(h)).toEqual(['info']);
    expect(messageTexts(h)[0]).toContain('Detach');
    expect(lessonResources(h, '01 One.webm')).toMatchObject([
      { id, type: 'url', path: 'https://example.com/a', missing: false },
    ]);
  });

  it('comes back when the Course is opened again', async () => {
    const { h, course } = await courseWithLesson();
    await typeUrl(h, h.core.attachCourseResource(), 'https://example.com/cheat');

    await h.core.openCourse(course);

    expect(courseResources(h)).toMatchObject([{ type: 'url', path: 'https://example.com/cheat' }]);
  });

  it('keeps a file and a URL of one Lesson in the order they were attached', async () => {
    const { h, course } = await courseWithLesson();
    await writeFile(join(course, 'notes.md'), '#');
    await typeUrl(h, h.core.attachResource('01 One.webm'), 'https://example.com/a');
    await h.core.attachResource('01 One.webm', join(course, 'notes.md'));

    expect(lessonResources(h, '01 One.webm').map((resource) => resource.type)).toEqual([
      'url',
      'file',
    ]);
  });
});

describe('attaching a URL from the chord', () => {
  it('attaches it to the Loaded Lesson and hands focus back to the code', async () => {
    const { h } = await courseWithLesson();
    h.player.ready();
    h.player.emit({ type: 'played', lessonId: '01 One.webm' });

    await typeUrl(h, h.core.attachToLoadedLesson(), 'https://example.com/chord');

    expect(lessonResources(h, '01 One.webm')).toMatchObject([
      { path: 'https://example.com/chord' },
    ]);
    expect(h.ui.focusReturns).toBe(1);
  });
});
