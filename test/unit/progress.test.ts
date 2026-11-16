import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const lessons = {
  '01 Intro.webm': 'video',
  '02 Setup.webm': 'video',
  '03 Closures.webm': 'video',
};

/** The player plays the current Lesson, reporting the playhead at `position` (of a 600 s Lesson). */
function playTo(h: Harness, lessonId: string, position: number): void {
  h.player.emit({ type: 'played', lessonId });
  h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
}

function pause(h: Harness, lessonId: string): void {
  h.player.emit({ type: 'paused', lessonId, byUser: true });
}

/** VS Code starts again and the learner opens the Course; returns the `load` the player gets. */
async function reopen(h: Harness, course: string) {
  await h.settle();
  h.restart();
  await h.core.openCourse(course);
  h.player.ready();
  return h.player.sent.at(-1);
}

describe('remembering where the learner is in each Lesson', () => {
  it('reopens the Course on the last Lesson played, paused 5 s before where the learner paused', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 42.5);
    pause(h, '02 Setup.webm');

    expect(await reopen(h, course)).toEqual({
      type: 'load',
      lessonId: '02 Setup.webm',
      videoUri: h.player.resourceUri(join(course, '02 Setup.webm')),
      container: 'webm',
      startAt: 37.5,
      autoplay: false,
    });
  });

  it('saves every 5 s while the Lesson plays', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 12);
    h.clock.advance(5000);
    await h.settle();
    h.player.emit({ type: 'timeUpdate', lessonId: '01 Intro.webm', position: 20, duration: 600 });
    h.clock.advance(5000);
    await h.settle();
    h.player.emit({ type: 'timeUpdate', lessonId: '01 Intro.webm', position: 24, duration: 600 });

    // VS Code stops without a word (a crash): what the last save wrote is what is left.
    expect(await reopen(h, course)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 15 });
  });

  it('saves nothing in the first 5 s of play unless something else asks for a save', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 3);
    h.clock.advance(4999);

    expect(await reopen(h, course)).toMatchObject({
      lessonId: '01 Intro.webm',
      startAt: 0,
      autoplay: true,
    });
    expect(await h.listFiles(course)).toEqual(Object.keys(lessons));
  });

  it('saves right away when the learner seeks, also before the Lesson has played', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.player.emit({ type: 'seeked', lessonId: '01 Intro.webm', position: 200 });

    expect(await reopen(h, course)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 195 });
  });

  it('saves the Lesson the learner leaves when they switch to another', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 50);
    h.core.playLesson('02 Setup.webm');

    // The Lesson switched to never played, so the last Lesson played is still the first one.
    expect(await reopen(h, course)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 45 });
  });

  it('plays a Lesson the learner comes back to from 5 s before where they left it', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 50);
    h.core.playLesson('02 Setup.webm');
    h.core.playLesson('01 Intro.webm');

    expect(h.player.sent.at(-1)).toMatchObject({
      lessonId: '01 Intro.webm',
      startAt: 45,
      autoplay: true,
    });
  });

  it('saves the open Course when the learner opens another one', async () => {
    const h = await createHarness();
    const first = await h.folder('first', lessons);
    const second = await h.folder('second', lessons);
    await h.core.openCourse(first);
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 80);
    await h.core.openCourse(second);

    expect(await reopen(h, first)).toMatchObject({ lessonId: '02 Setup.webm', startAt: 75 });
  });

  it('saves when the VS Code window closes', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 33);
    await h.core.close();

    expect(await reopen(h, course)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 28 });
  });

  it('keeps the saved position when the learner reopens a Lesson and leaves without playing it', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 100);
    pause(h, '01 Intro.webm');
    await reopen(h, course);
    // The player reports the playhead where FollowAlong put it, 5 s back; nothing is played.
    h.player.emit({ type: 'timeUpdate', lessonId: '01 Intro.webm', position: 95, duration: 600 });
    h.player.emit({ type: 'paused', lessonId: '01 Intro.webm', byUser: false });
    await h.core.close();

    expect(await reopen(h, course)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 95 });
  });
});

describe('reopening the workspace', () => {
  it('brings back the Course that was open, on the last Lesson played, paused', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('03 Closures.webm');
    playTo(h, '03 Closures.webm', 70);
    pause(h, '03 Closures.webm');
    await h.settle();

    h.restart();
    await h.core.restoreCourse();
    h.player.ready();

    expect(h.player.shown).toEqual([
      { title: '03 Closures.webm', resourceRoots: [course, h.storage.folder] },
    ]);
    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '03 Closures.webm', startAt: 65, autoplay: false },
    ]);
    expect(h.ui.lessonTree?.nodes).toHaveLength(3);
  });

  it('opens the first Lesson paused when the Course never played', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);

    h.restart();
    await h.core.restoreCourse();
    h.player.ready();

    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '01 Intro.webm', startAt: 0, autoplay: false },
    ]);
  });

  it('opens nothing when no Course was open in the workspace', async () => {
    const h = await createHarness();

    await h.core.restoreCourse();

    expect(h.player.shown).toEqual([]);
    expect(h.ui.messages).toEqual([]);
  });

  it('says once that the Course is missing when its folder moved while VS Code was closed', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    await rename(course, join(h.root, 'moved'));

    h.restart();
    await h.core.restoreCourse();
    h.restart();
    await h.core.restoreCourse();

    expect(h.player.shown).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'error', text: 'FollowAlong cannot open “course”: the folder is missing.' },
    ]);
  });
});
