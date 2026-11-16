import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

/** A Course of three Sections: one Lesson in the Course folder, then two in Section 1 and one in Section 2. */
const tree = {
  '00 Overview.webm': 'v',
  'Section 1/01 Welcome.webm': 'v',
  'Section 1/02 Setup.mp4': 'v',
  'Section 2/03 Tools.mp4': 'v',
} as const;

/** A Course open and its player ready, playing its first Lesson; what was sent so far is cleared. */
async function openCourse(h: Harness): Promise<void> {
  const course = await h.folder('Course', tree);
  await h.core.openCourse(course);
  h.player.ready();
  h.player.clearSent();
}

/** The ids of the Lessons the player was asked to load since the last clear, in order. */
function loadedLessons(h: Harness): string[] {
  return h.player.sent.flatMap((command) => (command.type === 'load' ? [command.lessonId] : []));
}

describe('Next Lesson', () => {
  it('loads the Lesson after the current one in Course order, across Section boundaries', async () => {
    const h = await createHarness();
    await openCourse(h);

    h.core.nextLesson();
    h.core.nextLesson();
    h.core.nextLesson();

    expect(loadedLessons(h)).toEqual([
      'Section 1/01 Welcome.webm',
      'Section 1/02 Setup.mp4',
      'Section 2/03 Tools.mp4',
    ]);
  });
});

describe('Previous Lesson', () => {
  it('loads the Lesson before the current one in Course order, across Section boundaries', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.core.playLesson('Section 2/03 Tools.mp4');
    h.player.clearSent();

    h.core.previousLesson();
    h.core.previousLesson();
    h.core.previousLesson();

    expect(loadedLessons(h)).toEqual([
      'Section 1/02 Setup.mp4',
      'Section 1/01 Welcome.webm',
      '00 Overview.webm',
    ]);
  });
});

describe('At the ends of the Course', () => {
  it('Next Lesson at the last Lesson does nothing: no load, no message, the same Lesson stays', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.core.playLesson('Section 2/03 Tools.mp4');
    h.player.clearSent();

    h.core.nextLesson();

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
    expect(h.ui.selectedLesson).toBe('Section 2/03 Tools.mp4');
    h.core.previousLesson();
    expect(loadedLessons(h)).toEqual(['Section 1/02 Setup.mp4']);
  });

  it('Previous Lesson at the first Lesson does nothing: no load, no message, the same Lesson stays', async () => {
    const h = await createHarness();
    await openCourse(h);

    h.core.previousLesson();

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
    expect(h.ui.selectedLesson).toBe('00 Overview.webm');
    h.core.nextLesson();
    expect(loadedLessons(h)).toEqual(['Section 1/01 Welcome.webm']);
  });

  it('a Course of one Lesson has no next or previous Lesson', async () => {
    const h = await createHarness();
    const course = await h.folder('Single', { 'Only.mp4': 'v' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.clearSent();

    h.core.nextLesson();
    h.core.previousLesson();

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });
});

describe('The Lesson tree selection', () => {
  it('follows the Lesson loaded by Next and Previous Lesson', async () => {
    const h = await createHarness();
    await openCourse(h);
    expect(h.ui.selectedLesson).toBe('00 Overview.webm');

    h.core.nextLesson();
    h.core.nextLesson();
    expect(h.ui.selectedLesson).toBe('Section 1/02 Setup.mp4');

    h.core.previousLesson();
    expect(h.ui.selectedLesson).toBe('Section 1/01 Welcome.webm');
  });
});

describe('Next and Previous Lesson before a Lesson is open', () => {
  it('say no Lesson is open, and send the player nothing', async () => {
    const h = await createHarness();

    h.core.nextLesson();
    h.core.previousLesson();

    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'FollowAlong: no Lesson is open. Open a Course first.' },
      { severity: 'info', text: 'FollowAlong: no Lesson is open. Open a Course first.' },
    ]);
    expect(h.player.sent).toEqual([]);
  });

  it('move on while the player page is still starting, and the player loads that Lesson when it is ready', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', tree);
    await h.core.openCourse(course);

    h.core.nextLesson();
    h.player.ready();

    expect(loadedLessons(h)).toEqual(['Section 1/01 Welcome.webm']);
    expect(h.ui.selectedLesson).toBe('Section 1/01 Welcome.webm');
  });
});

describe('Next and Previous Lesson in a Course with no Lessons', () => {
  it('say no Lesson is open when the Course the learner opened last has no Lessons', async () => {
    const h = await createHarness();
    await openCourse(h);
    const empty = await h.folder('Empty', { 'notes.pdf': 'x' });
    await h.core.openCourse(empty);
    h.ui.messages.length = 0;

    h.core.nextLesson();
    h.core.previousLesson();

    expect(h.ui.messages.map((message) => message.text)).toEqual([
      'FollowAlong: no Lesson is open. Open a Course first.',
      'FollowAlong: no Lesson is open. Open a Course first.',
    ]);
    expect(h.player.sent).toEqual([]);
  });
});

describe('Course order inside nested Sections', () => {
  it('goes through a Section’s own Lessons, then its nested Section, then the next Section', async () => {
    const h = await createHarness();
    const course = await h.folder('Nested', {
      'Part 1/01 A.mp4': 'v',
      'Part 1/Deep/02 B.mp4': 'v',
      'Part 2/03 C.mp4': 'v',
    });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.clearSent();

    h.core.nextLesson();
    h.core.nextLesson();
    expect(h.ui.selectedLesson).toBe('Part 2/03 C.mp4');
    h.core.previousLesson();
    h.core.previousLesson();

    expect(loadedLessons(h)).toEqual([
      'Part 1/Deep/02 B.mp4',
      'Part 2/03 C.mp4',
      'Part 1/Deep/02 B.mp4',
      'Part 1/01 A.mp4',
    ]);
    expect(h.ui.selectedLesson).toBe('Part 1/01 A.mp4');
  });
});
