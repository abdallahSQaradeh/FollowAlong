import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

/** The Lesson titles the learner reads in the tree, in tree order, Sections flattened. */
async function openedTitles(
  files: Readonly<Record<string, string>>,
  courseName = 'Course',
  prepare?: (h: Harness, course: string) => void,
) {
  const h = await createHarness();
  const course = await h.folder(courseName, files);
  prepare?.(h, course);
  await h.core.openCourse(course);
  const titles: string[] = [];
  const collect = (nodes: readonly { kind: string; label: string; children?: unknown }[]): void => {
    for (const node of nodes) {
      if (node.kind === 'section') {
        collect((node.children ?? []) as never);
      } else {
        titles.push(node.label);
      }
    }
  };
  collect(h.ui.lessonTree?.nodes ?? []);
  return titles;
}

describe('Lesson titles cleaned from file names', () => {
  it('drops the extension and the leading number', async () => {
    expect(
      await openedTitles({
        '01 Welcome.webm': 'v',
        '02. Setup.mp4': 'v',
        '03 - Tools.mp4': 'v',
        '04_Editors.webm': 'v',
      }),
    ).toEqual(['Welcome', 'Setup', 'Tools', 'Editors']);
  });

  it('keeps a number that is part of the title', async () => {
    expect(
      await openedTitles({ '3D Graphics.mp4': 'v', '1.5x Speed.mp4': 'v', 'ES6 Intro.mp4': 'v' }),
    ).toEqual(['1.5x Speed', '3D Graphics', 'ES6 Intro']);
  });

  it('drops a `Lesson N -` prefix, with or without a leading number', async () => {
    const titles = await openedTitles({
      'Lesson 1 - Variables.mp4': 'v',
      'lesson 2 – Functions.mp4': 'v',
      '03 Lesson 3 — Loops.webm': 'v',
    });

    expect([...titles].sort()).toEqual(['Functions', 'Loops', 'Variables']);
  });

  it('drops a trailing ` _ <Course name>`, however the case', async () => {
    const titles = await openedTitles(
      {
        '01 Intro _ Node Basics.mp4': 'v',
        'Lesson 2 - Modules _ node basics.mp4': 'v',
        '03 Other _ Another Course.mp4': 'v',
      },
      'Node Basics',
    );

    expect([...titles].sort()).toEqual(['Intro', 'Modules', 'Other _ Another Course']);
  });

  it('keeps the file name when cleaning would leave nothing', async () => {
    expect(await openedTitles({ '01.mp4': 'v', 'Lesson 2 - .webm': 'v' })).toEqual([
      '01',
      'Lesson 2 -',
    ]);
  });
});

describe('Lesson titles from a .txt title list', () => {
  const lessons = {
    '01 Welcome.mp4': 'v',
    'Section 2/02 Setup.mp4': 'v',
    'Section 2/03 Tools.webm': 'v',
  };

  it('uses the lines of a list with one line per Lesson, in Lesson order', async () => {
    const titles = await openedTitles({
      ...lessons,
      'titles.txt': 'Welcome to the Course\nSetting up your machine\nThe tools we use\n',
    });

    expect(titles).toEqual([
      'Welcome to the Course',
      'Setting up your machine',
      'The tools we use',
    ]);
  });

  it('ignores a list whose line count differs from the Lesson count', async () => {
    const tooFew = await openedTitles({ ...lessons, 'titles.txt': 'One\nTwo\n' });
    const tooMany = await openedTitles({ ...lessons, 'titles.txt': 'One\nTwo\nThree\nFour\n' });

    expect(tooFew).toEqual(['Welcome', 'Setup', 'Tools']);
    expect(tooMany).toEqual(['Welcome', 'Setup', 'Tools']);
  });

  it('reads Windows line endings, a byte order mark, blank lines and padding', async () => {
    const titles = await openedTitles({
      ...lessons,
      'titles.txt':
        '\uFEFFWelcome to the Course\r\n\r\n  Setting up  \r\n\r\nThe tools we use\r\n\r\n',
    });

    expect(titles).toEqual(['Welcome to the Course', 'Setting up', 'The tools we use']);
  });

  it('takes the first .txt whose line count fits, so a stray notes file does not block it', async () => {
    const titles = await openedTitles({
      ...lessons,
      'a notes.txt': 'Read me first\nAnd this\n',
      'b titles.txt': 'One\nTwo\nThree\n',
      'c other.txt': 'Four\nFive\nSix\n',
    });

    expect(titles).toEqual(['One', 'Two', 'Three']);
  });

  it('finds the list in a wrapper folder around the Lessons', async () => {
    const titles = await openedTitles({
      'Wrapper/titles.txt': 'One\nTwo\n',
      'Wrapper/Inner/a.mp4': 'v',
      'Wrapper/Inner/b.mp4': 'v',
    });

    expect(titles).toEqual(['One', 'Two']);
  });

  it('does not take a .txt inside a Section for the Course title list', async () => {
    const titles = await openedTitles({
      'a.mp4': 'v',
      'b.mp4': 'v',
      'Section 1/c.mp4': 'v',
      'Section 1/lines.txt': 'One\nTwo\nThree\n',
    });

    expect(titles).toEqual(['a', 'b', 'c']);
  });

  it('cleans file names when the list cannot be read, and says so', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'a.mp4': 'v', 'titles.txt': 'One\n' });
    h.makeUnreadable(join(course, 'titles.txt'));
    await h.core.openCourse(course);
    expect(h.ui.lessonTree?.nodes.map((node) => node.label)).toEqual(['a']);
    expect(h.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });
});
