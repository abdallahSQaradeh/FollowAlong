import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const lessons = {
  '01 Intro.webm': 'video',
  '02 Setup.webm': 'video',
};
const lessonId = '01 Intro.webm';
const duration = 600;

/** What the player reports while the Lesson plays: a `timeUpdate` every second, as a 1× video. */
function playFor(h: Harness, seconds: number, from = 0): void {
  h.player.emit({ type: 'played', lessonId });
  for (let tick = 0; tick <= seconds; tick += 1) {
    h.player.emit({ type: 'timeUpdate', lessonId, position: from + tick, duration });
  }
}

function pause(h: Harness): void {
  h.player.emit({ type: 'paused', lessonId, byUser: true });
}

/** The learner moves the playhead to `position`: the player reports where it is, then `seeked`. */
function seekTo(h: Harness, position: number): void {
  h.player.emit({ type: 'timeUpdate', lessonId, position, duration });
  h.player.emit({ type: 'seeked', lessonId });
}

/** Opens `lessons` as a Course and loads its first Lesson; its player is ready. */
async function openCourse(h: Harness): Promise<string> {
  const course = await h.folder('course', lessons);
  await h.core.openCourse(course);
  h.player.ready();
  return course;
}

/** How the Course's progress file records the Lesson: `notStarted` when it has no mark. */
function savedStatus(course: string, id = lessonId): string | undefined {
  const text = readFileSync(join(course, '.followalong', 'progress.json'), 'utf8');
  const file = JSON.parse(text) as {
    data: { lessons: Record<string, { status?: string } | undefined> };
  };
  return file.data.lessons[id]?.status ?? 'notStarted';
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

describe('a Lesson is in progress after 10 s of play', () => {
  it('leaves a Lesson not started when it played for less than 10 s', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 9);
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('notStarted');
  });

  it('makes a Lesson in progress once it has played for 10 s', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 10);
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('inProgress');
  });
});

describe('a Lesson is done in its last 5 % or at its end', () => {
  it('marks a Lesson done when the playhead reaches 95 % while it plays', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 12, 562);
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('done');
  });

  it('marks a Lesson done when the player reports its end, wherever the playhead was', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 12, 200);
    h.player.emit({ type: 'ended', lessonId });
    await h.settle();

    expect(savedStatus(course)).toBe('done');
  });

  it('marks a Lesson done at exactly 95 % and not a moment before', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    seekTo(h, 569.9);
    await h.settle();
    expect(savedStatus(course)).toBe('notStarted');
    seekTo(h, 570);
    await h.settle();

    expect(savedStatus(course)).toBe('done');
  });

  it('keeps a Lesson that ended done when the learner steps back into it', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 12, 588);
    h.player.emit({ type: 'ended', lessonId });
    seekTo(h, 300);
    playFor(h, 3, 300);
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('done');
  });

  it('counts play at 2× and in a throttled page, where the playhead moves 2 s between reports', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    h.player.emit({ type: 'played', lessonId });
    for (let tick = 0; tick <= 5; tick += 1) {
      h.player.emit({ type: 'timeUpdate', lessonId, position: tick * 2, duration });
    }
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('inProgress');
  });

  it('does not count a step forward as play', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    h.player.emit({ type: 'played', lessonId });
    for (let tick = 0; tick <= 4; tick += 1) {
      h.player.emit({ type: 'timeUpdate', lessonId, position: tick * 5, duration });
    }
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('notStarted');
  });

  it('marks a Lesson done when the learner seeks into its last 5 % before it ever played', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    seekTo(h, 580);
    await h.settle();

    expect(savedStatus(course)).toBe('done');
  });

  it('keeps a Lesson done when the learner seeks back and plays on', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    seekTo(h, 590);
    seekTo(h, 100);
    playFor(h, 3, 100);
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('done');
  });

  it('starts a done Lesson saved in its last 5 % again at 0:00', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 12, 590);
    pause(h);

    expect(await reopen(h, course)).toMatchObject({ lessonId, startAt: 0 });
  });

  it('starts a Lesson that ended at 0:00 even when the player never knew its length', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    h.player.emit({ type: 'played', lessonId });
    for (let tick = 0; tick <= 12; tick += 1) {
      h.player.emit({ type: 'timeUpdate', lessonId, position: 300 + tick, duration: 0 });
    }
    h.player.emit({ type: 'ended', lessonId });

    expect(await reopen(h, course)).toMatchObject({ lessonId, startAt: 0 });
  });

  it('starts a done Lesson the learner left earlier 5 s before its saved position', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    seekTo(h, 590);
    seekTo(h, 200);
    pause(h);

    expect(await reopen(h, course)).toMatchObject({ lessonId, startAt: 195 });
  });
});

describe('a learner seek while FollowAlong’s own start seek is pending', () => {
  /** The Lesson was left at 100 s; reopening it makes the player seek to 95 s. */
  async function reopenedAt95(h: Harness): Promise<string> {
    const course = await openCourse(h);
    playFor(h, 12, 88);
    pause(h);
    await reopen(h, course);
    return course;
  }

  it('records the learner’s seek, not swallows it as the start seek', async () => {
    const h = await createHarness();
    const course = await reopenedAt95(h);
    // Chromium aborts the slow start seek and reports one `seeked`, at the learner's position.
    seekTo(h, 300);
    await h.core.close();

    expect(await reopen(h, course)).toMatchObject({ lessonId, startAt: 295 });
  });

  it('marks the Lesson done when that seek lands in its last 5 %', async () => {
    const h = await createHarness();
    const course = await reopenedAt95(h);
    seekTo(h, 590);
    await h.core.close();

    expect(savedStatus(course)).toBe('done');
  });

  it('still takes the seek to the start position as FollowAlong’s own', async () => {
    const h = await createHarness();
    const course = await reopenedAt95(h);
    seekTo(h, 95.2);
    await h.core.close();

    expect(await reopen(h, course)).toMatchObject({ lessonId, startAt: 95 });
  });
});
