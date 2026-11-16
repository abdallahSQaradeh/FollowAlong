import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness } from './harness.js';

describe('opening a Course', () => {
  it('plays its first Lesson in the player beside the code, with sound', async () => {
    const h = await createHarness();
    const course = await h.folder('JavaScript The Advanced Concepts', {
      'Section 1/01 Welcome.webm': 'video',
      'Section 1/02 Setup.webm': 'video',
      'notes.pdf': 'pdf',
    });

    await h.core.openCourse(course);
    h.player.ready();

    expect(h.player.shown).toEqual([
      { title: '01 Welcome.webm', resourceRoots: [course, h.storage.folder] },
    ]);
    expect(h.player.sent).toEqual([
      {
        type: 'load',
        lessonId: 'Section 1/01 Welcome.webm',
        videoUri: h.player.resourceUri(join(course, 'Section 1', '01 Welcome.webm')),
        container: 'webm',
        startAt: 0,
        autoplay: true,
      },
    ]);
  });

  it('changes nothing in the Course folder', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '01 Welcome.webm': 'video',
      'code.zip': 'zip',
      'Section 2/lesson.webm': 'video',
    });
    const before = await h.listFiles(course);

    await h.core.openCourse(course);
    h.player.ready();

    expect(await h.listFiles(course)).toEqual(before);
  });

  it('takes the first Lesson in natural order, files before Section folders', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      'lesson10.webm': 'video',
      'lesson2.webm': 'video',
      'A first section/lesson1.webm': 'video',
    });

    await h.core.openCourse(course);
    h.player.ready();

    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: 'lesson2.webm' }]);
  });

  it("never plays a video from FollowAlong's own .followalong folder", async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/cached.webm': 'video',
      'Section 1/intro.webm': 'video',
    });

    await h.core.openCourse(course);
    h.player.ready();

    expect(h.player.sent).toMatchObject([{ type: 'load', lessonId: 'Section 1/intro.webm' }]);
  });

  it('says so, and opens no player, when the folder holds no Lessons', async () => {
    const h = await createHarness();
    const course = await h.folder('Zipped course', { 'course.zip': 'zip', 'notes.pdf': 'pdf' });

    await h.core.openCourse(course);

    const text =
      'FollowAlong found no Lessons (.mp4 or .webm) in “Zipped course”. If the Course is zipped, extract it first.';
    expect(h.player.shown).toEqual([]);
    expect(h.ui.messages).toEqual([{ severity: 'warning', text }]);
    expect(h.ui.lessonTree).toEqual({ message: text, nodes: [] });
  });

  it('loads the Lesson again when the player page reloads', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'intro.webm': 'video' });

    await h.core.openCourse(course);
    h.player.ready();
    h.player.ready();

    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: 'intro.webm' },
      { type: 'load', lessonId: 'intro.webm' },
    ]);
  });

  it('replaces the open Course in the player that is already open', async () => {
    const h = await createHarness();
    const first = await h.folder('first', { 'a.webm': 'video' });
    const second = await h.folder('second', { 'b.webm': 'video' });

    await h.core.openCourse(first);
    h.player.ready();
    await h.core.openCourse(second);
    h.player.ready();

    expect(h.player.shown.map((shown) => shown.resourceRoots[0])).toEqual([first, second]);
    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: 'a.webm' },
      { type: 'load', lessonId: 'b.webm' },
    ]);
  });

  it('loads at once when the same Course is opened again in the open player', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'intro.webm': 'video' });

    await h.core.openCourse(course);
    h.player.ready();
    await h.core.openCourse(course);

    expect(h.player.sent).toMatchObject([
      { type: 'load', lessonId: 'intro.webm' },
      { type: 'load', lessonId: 'intro.webm' },
    ]);
  });

  it('waits for the new player page after the learner closed the player', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.close();

    await h.core.openCourse(course);
    expect(h.player.sent).toHaveLength(1);
    h.player.ready();

    expect(h.player.sent).toHaveLength(2);
  });

  it('sends nothing to a new player page before it is ready', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.close();

    await h.core.openCourse(course);
    await h.core.openCourse(course);
    expect(h.player.sent).toHaveLength(1);
    h.player.ready();

    expect(h.player.sent).toHaveLength(2);
  });

  it('says to press play when VS Code does not let the Lesson start by itself', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    h.player.emit({ type: 'paused', lessonId: '01 Intro.webm', byUser: false });

    expect(h.ui.messages).toEqual([
      {
        severity: 'info',
        text: 'VS Code did not let “01 Intro.webm” start by itself. Press play in the player to start it.',
      },
    ]);
  });

  it('says nothing about pauses once the Lesson has played', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    h.player.emit({ type: 'played', lessonId: '01 Intro.webm' });
    h.player.emit({ type: 'paused', lessonId: '01 Intro.webm', byUser: false });
    h.player.emit({ type: 'paused', lessonId: '01 Intro.webm', byUser: true });

    expect(h.ui.messages).toEqual([]);
  });

  it('shows an error when the player cannot play the Lesson', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();

    h.player.emit({ type: 'error', lessonId: '01 Intro.webm', message: 'decode failed' });

    expect(h.ui.messages).toEqual([
      { severity: 'error', text: 'FollowAlong could not play “01 Intro.webm”: decode failed' },
    ]);
  });

  it('shows an error when the Course folder does not exist', async () => {
    const h = await createHarness();

    await h.core.openCourse(join(h.root, 'moved away'));

    expect(h.player.shown).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'error', text: 'FollowAlong cannot open “moved away”: the folder is missing.' },
    ]);
  });
});
