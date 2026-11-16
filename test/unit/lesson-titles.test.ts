import { describe, expect, it } from 'vitest';

import { createHarness } from './harness.js';

/** The Lesson titles the learner reads in the tree, in tree order, Sections flattened. */
async function openedTitles(files: Readonly<Record<string, string>>, courseName = 'Course') {
  const h = await createHarness();
  const course = await h.folder(courseName, files);
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
