import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';
import { makeReadOnly } from './read-only.js';

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
  h.clock.advance(60_000);
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

  it('starts a Lesson left in its first 5 s at 0:00', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 3.2);
    pause(h, '02 Setup.webm');

    expect(await reopen(h, course)).toMatchObject({
      lessonId: '02 Setup.webm',
      startAt: 0,
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
    // The player reports the new playhead with a timeUpdate before the seeked (HTML seek steps).
    h.player.emit({ type: 'timeUpdate', lessonId: '01 Intro.webm', position: 200, duration: 600 });
    h.player.emit({ type: 'seeked', lessonId: '01 Intro.webm' });

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

  it('never saves an event of the Lesson left behind into the Course opened next', async () => {
    const h = await createHarness();
    const first = await h.folder('first', lessons);
    const second = await h.folder('second', lessons);
    await h.core.openCourse(first);
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 80);

    // The old Lesson keeps reporting while the second Course opens, at every step of the way.
    const opening = { done: false };
    const opened = h.core.openCourse(second).then(() => {
      opening.done = true;
    });
    for (let position = 81; !opening.done; position += 1) {
      h.player.emit({ type: 'timeUpdate', lessonId: '02 Setup.webm', position, duration: 600 });
      await new Promise((resolve) => setImmediate(resolve));
    }
    await opened;
    await h.core.close();

    expect(await reopen(h, second)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 0 });
  });

  it('saves the Lesson left behind when the window closes while another Course opens', async () => {
    // The window can close at any step of the opening; try each one.
    for (let steps = 0; steps < 12; steps += 1) {
      const h = await createHarness();
      const first = await h.folder('first', lessons);
      const second = await h.folder('second', lessons);
      await h.core.openCourse(first);
      h.player.ready();
      h.core.playLesson('02 Setup.webm');
      playTo(h, '02 Setup.webm', 80);
      const opened = h.core.openCourse(second);
      for (let step = 0; step < steps; step += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await h.core.close();
      // VS Code ends the extension host once close() settles: what is on disk now is what stays.
      const onDisk: unknown = JSON.parse(
        readFileSync(join(first, '.followalong', 'progress.json'), 'utf8'),
      );
      await opened;

      expect(onDisk, `closed after ${String(steps)} steps`).toMatchObject({
        data: { lessons: { '02 Setup.webm': { position: 80 } } },
      });
    }
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
    // The player seeks to where FollowAlong starts the Lesson, 5 s back; nothing is played.
    h.player.emit({ type: 'timeUpdate', lessonId: '01 Intro.webm', position: 95, duration: 600 });
    h.player.emit({ type: 'seeked', lessonId: '01 Intro.webm' });
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
      { title: 'Closures', resourceRoots: [course, h.storage.folder] },
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

  it('lets a Course the learner opens win over the one being restored at startup', async () => {
    const h = await createHarness();
    // Many Sections: reading it takes longer than reading the Course the learner picks.
    const remembered = await h.folder(
      'remembered',
      Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`Section ${String(index)}/lesson.webm`, 'video']),
      ),
    );
    const picked = await h.folder('picked', lessons);
    await h.core.openCourse(remembered);

    h.restart();
    await Promise.all([h.core.restoreCourse(), h.core.openCourse(picked)]);
    h.player.ready();

    expect(h.player.shown.at(-1)?.resourceRoots[0]).toBe(picked);
    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: '01 Intro.webm', autoplay: true },
    ]);
    h.restart();
    await h.core.restoreCourse();
    expect(h.player.shown.at(-1)?.resourceRoots[0]).toBe(picked);
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

describe('Progress kept with the Course', () => {
  it('writes each Lesson’s position into the Course’s .followalong folder, by its path in the Course', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'Section 1/01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, 'Section 1/01 Intro.webm', 42);
    pause(h, 'Section 1/01 Intro.webm');
    await h.settle();

    expect(
      JSON.parse(await readFile(join(course, '.followalong', 'progress.json'), 'utf8')),
    ).toEqual({
      version: 1,
      data: {
        lessons: {
          'Section 1/01 Intro.webm': { position: 42, duration: 600, savedAt: h.clock.now() },
        },
        last: { lessonId: 'Section 1/01 Intro.webm', savedAt: h.clock.now() },
      },
    });
  });

  it('keeps Progress when the learner moves or renames the Course folder', async () => {
    const h = await createHarness();
    const course = await h.folder('Downloads/JavaScript', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 125);
    pause(h, '02 Setup.webm');
    await h.settle();
    await mkdir(join(h.root, 'Courses'));
    const moved = join(h.root, 'Courses', 'JavaScript The Advanced Concepts');
    await rename(course, moved);

    expect(await reopen(h, moved)).toMatchObject({ lessonId: '02 Setup.webm', startAt: 120 });
  });

  it('never makes the Course folder again when it moves away while open, and says Progress was not saved', async () => {
    const h = await createHarness();
    const course = await h.folder('Downloads/course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 30);
    await rename(course, join(h.root, 'moved'));
    pause(h, '01 Intro.webm');
    await h.settle();
    playTo(h, '01 Intro.webm', 31);
    pause(h, '01 Intro.webm');
    await h.settle();

    expect(await h.listFiles(join(h.root, 'Downloads'))).toEqual([]);
    expect(await h.listFiles(h.storage.folder).catch(() => [])).toEqual([]);
    expect(h.ui.messages).toEqual([
      {
        severity: 'error',
        text: 'FollowAlong could not save your Progress in “course”: the Course folder is missing.',
      },
    ]);
  });

  it('reads both copies, newest Lesson wins, when the Course turned read-only after a save', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 50);
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 20);
    pause(h, '02 Setup.webm');
    await h.settle();
    makeReadOnly(join(course, '.followalong'));

    // The next session can only write to the fallback storage.
    expect(await reopen(h, course)).toMatchObject({ lessonId: '02 Setup.webm', startAt: 15 });
    playTo(h, '02 Setup.webm', 300);
    pause(h, '02 Setup.webm');

    // The session after it finds the old copy in .followalong and the newer one in the fallback.
    expect(await reopen(h, course)).toMatchObject({ lessonId: '02 Setup.webm', startAt: 295 });
    expect(await h.listFiles(course)).toEqual([
      '.followalong/progress.json',
      ...Object.keys(lessons),
    ]);
    h.core.playLesson('01 Intro.webm');
    expect(h.player.sent.at(-1)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 45 });
  });

  it('keeps Progress in the extension storage when the Course is read-only, and resumes from it', async () => {
    const h = await createHarness();
    const course = await h.folder('read-only course', lessons);
    makeReadOnly(course);
    await h.core.openCourse(course);
    h.player.ready();
    playTo(h, '01 Intro.webm', 64);
    pause(h, '01 Intro.webm');

    expect(await reopen(h, course)).toMatchObject({ lessonId: '01 Intro.webm', startAt: 59 });
    expect(await h.listFiles(course)).toEqual(Object.keys(lessons));
    expect(await h.listFiles(h.storage.folder)).toEqual([
      expect.stringMatching(/^courses\/read-only course-[0-9a-f]{16}\/progress\.json$/),
    ]);
    expect(h.ui.messages).toEqual([]);
  });
});
