import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

/** A Course of three Lessons in two Sections. */
const tree = {
  '00 Overview.webm': 'v',
  'Section 1/01 Welcome.webm': 'v',
  'Section 1/02 Setup.mp4': 'v',
} as const;

const overview = '00 Overview.webm';
const welcome = 'Section 1/01 Welcome.webm';
const setup = 'Section 1/02 Setup.mp4';

/** A Course open with its player ready; what was sent so far is cleared. */
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

describe('The end of a Lesson', () => {
  it('tells the player to show the next Lesson’s title, and does not load it', async () => {
    const h = await createHarness();
    await openCourse(h);

    h.player.emit({ type: 'ended', lessonId: overview });

    expect(h.player.sent).toEqual([{ type: 'showNext', title: 'Welcome' }]);
    expect(h.ui.selectedLesson).toBe(overview);
  });

  it('never moves on by itself, however long the learner leaves it', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.emit({ type: 'ended', lessonId: overview });
    h.player.clearSent();

    h.clock.advance(24 * 60 * 60 * 1000);

    expect(h.player.sent).toEqual([]);
    expect(h.ui.selectedLesson).toBe(overview);
  });
});

describe('Clicking the Next overlay', () => {
  it('loads the next Lesson in Course order', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.emit({ type: 'ended', lessonId: overview });
    h.player.clearSent();

    h.player.emit({ type: 'nextClicked', lessonId: overview });

    expect(loadedLessons(h)).toEqual([welcome]);
    expect(h.ui.selectedLesson).toBe(welcome);
  });

  it('goes on through the Course one Lesson per click, across Sections', async () => {
    const h = await createHarness();
    await openCourse(h);

    h.player.emit({ type: 'nextClicked', lessonId: overview });
    h.player.emit({ type: 'nextClicked', lessonId: welcome });

    expect(loadedLessons(h)).toEqual([welcome, setup]);
  });
});

describe('The end of the last Lesson', () => {
  it('shows no Next overlay, and loads nothing', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.core.playLesson(setup);
    h.player.clearSent();

    h.player.emit({ type: 'ended', lessonId: setup });

    expect(h.player.sent).toEqual([]);
    expect(h.ui.selectedLesson).toBe(setup);
  });

  it('a click that still arrives for it loads nothing either', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.core.playLesson(setup);
    h.player.clearSent();

    h.player.emit({ type: 'nextClicked', lessonId: setup });

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });

  it('a Course of one Lesson ends without an overlay', async () => {
    const h = await createHarness();
    const course = await h.folder('Single', { 'Only.mp4': 'v' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.clearSent();

    h.player.emit({ type: 'ended', lessonId: 'Only.mp4' });

    expect(h.player.sent).toEqual([]);
  });
});

describe('Late events about a Lesson that is no longer the current one', () => {
  it('an end shows no overlay for a Lesson the learner has already left', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.core.playLesson(setup);
    h.player.clearSent();

    h.player.emit({ type: 'ended', lessonId: overview });

    expect(h.player.sent).toEqual([]);
  });

  it('a click on the overlay of a Lesson the learner has already left loads nothing', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.core.playLesson(welcome);
    h.player.clearSent();

    h.player.emit({ type: 'nextClicked', lessonId: overview });

    expect(h.player.sent).toEqual([]);
    expect(h.ui.selectedLesson).toBe(welcome);
  });
});

describe('The title in the overlay', () => {
  it('is the Lesson title from the Title list, when the Course has one', async () => {
    const h = await createHarness();
    const course = await h.folder('Titled', {
      '01 a.mp4': 'v',
      '02 b.mp4': 'v',
      'titles.txt': 'Welcome to the Course\nSetting up your machine\n',
    });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.clearSent();

    h.player.emit({ type: 'ended', lessonId: '01 a.mp4' });

    expect(h.player.sent).toEqual([{ type: 'showNext', title: 'Setting up your machine' }]);
  });
});

describe('After the overlay is shown', () => {
  it('the next-Lesson key loads the same Lesson the click would', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.emit({ type: 'ended', lessonId: overview });
    h.player.clearSent();

    h.core.nextLesson();

    expect(loadedLessons(h)).toEqual([welcome]);
  });

  it('a click that arrives after another Course without Lessons was opened loads nothing and says nothing', async () => {
    const h = await createHarness();
    await openCourse(h);
    h.player.emit({ type: 'ended', lessonId: overview });
    await h.core.openCourse(await h.folder('Empty', { 'notes.pdf': 'x' }));
    h.ui.messages.length = 0;
    h.player.clearSent();

    h.player.emit({ type: 'nextClicked', lessonId: overview });

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });
});
