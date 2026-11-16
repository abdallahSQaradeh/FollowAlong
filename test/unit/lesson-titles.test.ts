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

  it('finds the list in a wrapper folder that has an empty folder beside the Lessons', async () => {
    const titles = await openedTitles(
      {
        'Wrapper/Inner/titles.txt': 'One\nTwo\n',
        'Wrapper/Inner/a.mp4': 'v',
        'Wrapper/Inner/b.mp4': 'v',
        'Wrapper/Empty/readme.pdf': 'x',
      },
      'Course',
    );

    expect(titles).toEqual(['One', 'Two']);
  });

  it('tries the list of the outer wrapper before the one inside it', async () => {
    const titles = await openedTitles({
      'Outer/titles.txt': 'Outer one\nOuter two\n',
      'Outer/Inner/titles.txt': 'Inner one\nInner two\n',
      'Outer/Inner/a.mp4': 'v',
      'Outer/Inner/b.mp4': 'v',
    });

    expect(titles).toEqual(['Outer one', 'Outer two']);
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

describe('the Course name a cleaned title drops, for a Course under wrapper folders', () => {
  /** A download as it often lands: the Lessons one folder below the folder named after the Course. */
  const dockerMastery = {
    'Docker Mastery/docker-mastery-2024/01 Intro _ Docker Mastery.mp4': 'v',
    'Docker Mastery/docker-mastery-2024/02 Setup _ docker mastery.mp4': 'v',
    'Docker Mastery/docker-mastery-2024/.followalong/progress.json': JSON.stringify({
      version: 1,
      data: {
        lessons: {
          '02 Setup _ docker mastery.mp4': {
            position: 30,
            duration: 600,
            savedAt: 1000,
            status: 'inProgress',
          },
        },
        last: { lessonId: '02 Setup _ docker mastery.mp4', savedAt: 1000 },
      },
    }),
  };

  /** The Lesson titles in the tree, flat: the Course has no Sections. */
  function treeTitles(h: Harness): string[] {
    return (h.ui.lessonTree?.nodes ?? []).map((node) => node.label);
  }

  it('drops the wrapper’s name, as the Course picker shows it, opened from the picker', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', dockerMastery);
    h.config.set('coursesRoots', [learning]);

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    const line = h.ui.picker?.entries.find(
      (entry) => entry.kind === 'item' && entry.label === 'Docker Mastery',
    );
    h.ui.choose('Docker Mastery');
    await picking;

    expect(line?.kind === 'item' ? line.detail : undefined).toBe('0/2 · 0% · last: Setup');
    expect(treeTitles(h)).toEqual(['Intro', 'Setup']);
  });

  it('gives the same titles when the Course is opened by its folder (Recent, a restore)', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', dockerMastery);
    h.config.set('coursesRoots', [learning]);

    await h.core.openCourse(join(learning, 'Docker Mastery', 'docker-mastery-2024'));

    expect(treeTitles(h)).toEqual(['Intro', 'Setup']);
  });

  it('also drops a category folder’s name: an accepted over-strip of a title ending in it', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React Basics/01 Intro _ Web.mp4': 'v',
      'Web/Vue Basics/01 Hello.webm': 'v',
    });
    h.config.set('coursesRoots', [learning]);

    await h.core.openCourse(join(learning, 'Web', 'React Basics'));

    expect(treeTitles(h)).toEqual(['Intro']);
  });

  it('drops only one name, and never the Courses root’s', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Docker Mastery/docker-mastery-2024/01 Intro _ Learning.mp4': 'v',
      'Docker Mastery/docker-mastery-2024/02 Setup _ Docker Mastery _ docker-mastery-2024.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);

    await h.core.openCourse(join(learning, 'Docker Mastery', 'docker-mastery-2024'));

    expect(treeTitles(h)).toEqual(['Intro _ Learning', 'Setup _ Docker Mastery']);
  });

  it('drops only its own name for a Course that is a Courses root, whatever root holds it', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Docker Mastery/docker-mastery-2024/01 Intro _ Docker Mastery.mp4': 'v',
    });
    const course = join(learning, 'Docker Mastery', 'docker-mastery-2024');
    // The scan names this Course after its own folder: it is a root, the one named first.
    h.config.set('coursesRoots', [course, learning]);

    await h.core.openCourse(course);

    expect(treeTitles(h)).toEqual(['Intro _ Docker Mastery']);
  });

  it('drops only the Course folder’s own name when the Course is under no Courses root', async () => {
    const h = await createHarness();
    const outer = await h.folder('Docker Mastery', {
      'docker-mastery-2024/01 Intro _ Docker Mastery.mp4': 'v',
      'docker-mastery-2024/02 Setup _ docker-mastery-2024.mp4': 'v',
    });

    await h.core.openCourse(join(outer, 'docker-mastery-2024'));

    expect(treeTitles(h)).toEqual(['Intro _ Docker Mastery', 'Setup']);
  });
});
