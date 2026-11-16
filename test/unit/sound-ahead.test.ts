/**
 * Preparing sound ahead (spec #12, Sound for MP4 Lessons; ticket #44): after the opened Lesson's
 * sound is ready, the next 3 Lessons in Course order are converted one at a time, in the
 * background. Opening another Lesson reorders the queue and cancels what is no longer needed.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

/** The Lessons of a Course of `count` MP4 Lessons: `01 Lesson.mp4`, `02 Lesson.mp4`, … */
function lessons(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${String(index + 1).padStart(2, '0')} Lesson.mp4`,
      `mp4 video ${String(index + 1)}`,
    ]),
  );
}

/** Opens a Course in a player that cannot decode AAC. Returns the Course folder. */
async function openCourse(
  h: Harness,
  tree: Record<string, string>,
  name = 'course',
): Promise<string> {
  const course = await h.folder(name, tree);
  await h.core.openCourse(course);
  h.player.ready(false);
  await h.settle();
  return course;
}

/** The Lesson files the converter was asked to convert, in order, as their numbers. */
function converting(h: Harness, course: string): string[] {
  return h.converter.requests.map(({ request }) =>
    request.input.slice(course.length + 1).slice(0, 2),
  );
}

/** Succeeds the conversion that is under way, as ffmpeg finishing it does. */
async function finishNext(h: Harness, index: number): Promise<void> {
  await h.converter.requests[index]?.succeed();
  await h.settle();
}

describe('preparing sound ahead', () => {
  it('converts the opened Lesson first, then the next 3 in Course order, one at a time', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(6));

    expect(converting(h, course)).toEqual(['01']);
    await finishNext(h, 0);
    expect(converting(h, course)).toEqual(['01', '02']);
    await finishNext(h, 1);
    expect(converting(h, course)).toEqual(['01', '02', '03']);
    await finishNext(h, 2);
    expect(converting(h, course)).toEqual(['01', '02', '03', '04']);
    await finishNext(h, 3);

    // Only the next 3: the 5th Lesson is not prepared until the learner gets closer.
    expect(converting(h, course)).toEqual(['01', '02', '03', '04']);
    expect(h.ui.messages).toEqual([]);
  });

  it('asks for every conversion to run at low process priority', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(3));
    await finishNext(h, 0);
    await finishNext(h, 1);

    expect(converting(h, course)).toEqual(['01', '02', '03']);
    expect(h.converter.requests.map(({ request }) => request.lowPriority)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('puts a Lesson the learner opens first, and stops the work no longer needed', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(8));
    await finishNext(h, 0);
    const stale = h.converter.requests[1];
    expect(converting(h, course)).toEqual(['01', '02']);

    h.core.playLesson('06 Lesson.mp4');
    await h.settle();

    expect(stale?.request.signal.aborted).toBe(true);
    expect(converting(h, course)).toEqual(['01', '02', '06']);
    await finishNext(h, 2);
    await finishNext(h, 3);
    await finishNext(h, 4);
    // 06 first, then 07 and 08 after it; 03 and 04 were in the way of nothing and are not done.
    expect(converting(h, course)).toEqual(['01', '02', '06', '07', '08']);
    expect(h.ui.messages).toEqual([]);
  });

  it('goes on with the conversion of the Lesson the learner moves on to, from where it was', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(5));
    await finishNext(h, 0);
    const next = h.converter.requests[1];
    next?.progress(40);

    h.core.nextLesson();
    await h.settle();

    // The same conversion: not stopped, not started again, and its progress is the opened Lesson's.
    expect(next?.request.signal.aborted).toBe(false);
    expect(converting(h, course)).toEqual(['01', '02']);
    expect(h.player.sent.filter((command) => command.type === 'soundProgress')).toContainEqual({
      type: 'soundProgress',
      percent: 40,
    });
    await next?.succeed();
    await h.settle();
    expect(h.player.sent.filter((command) => command.type === 'soundReady').at(-1)).toEqual({
      type: 'soundReady',
      audioUri: h.player.resourceUri(next?.request.output ?? ''),
    });
    // The 3 after it come next: 03, 04 and 05.
    expect(converting(h, course)).toEqual(['01', '02', '03']);
  });

  it('skips Lessons whose sound is prepared already', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(5));
    for (const index of [0, 1, 2, 3]) {
      await finishNext(h, index);
    }
    expect(converting(h, course)).toEqual(['01', '02', '03', '04']);

    await h.core.close();
    h.restart();
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();

    expect(h.converter.requests).toHaveLength(4);
    expect(await h.listFiles(join(course, '.followalong', 'sound'))).toHaveLength(4);
  });

  it('skips Lessons that need no conversion: a WebM, a silent video, a sound the page decodes', async () => {
    const h = await createHarness();
    const course = await openCourse(h, {
      '01 Lesson.mp4': 'mp4 video 1',
      '02 Lesson.webm': 'webm video',
      '03 Lesson.mp4': 'mp4 video 3',
      '04 Lesson.mp4': 'mp4 video 4',
    });
    await finishNext(h, 0);
    expect(converting(h, course)).toEqual(['01', '03']);
    h.converter.audioCodec = undefined;
    await finishNext(h, 1);
    // 04 is silent: it needs no conversion, and nothing is shown for it.
    expect(converting(h, course)).toEqual(['01', '03']);
    expect(h.converter.probes.map(({ input }) => input.slice(course.length + 1, -4))).toEqual([
      '01 Lesson',
      '03 Lesson',
      '04 Lesson',
    ]);
    expect(h.ui.messages).toEqual([]);
  });

  it('prepares nothing ahead when the page plays AAC itself', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons(4));
    await h.core.openCourse(course);
    h.player.ready(true);
    await h.settle();

    expect(h.converter.requests).toEqual([]);
    expect(h.converter.probes).toEqual([]);
  });

  it('shows nothing when a Lesson ahead fails, goes on with the next, and tries it again when it is opened', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(4));
    await finishNext(h, 0);
    h.converter.requests[1]?.fail('ffmpeg exited with code 1: Invalid data');
    await h.settle();

    expect(converting(h, course)).toEqual(['01', '02', '03']);
    expect(h.ui.messages).toEqual([]);
    expect(h.player.sent.filter((command) => command.type === 'soundFailed')).toEqual([]);
    const lines = h.logger.entries.filter((entry) => entry.message.includes('ahead of time'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(lines[0]?.message).toContain('02 Lesson.mp4');
    expect(lines[0]?.message).toContain('Invalid data');
    await finishNext(h, 2);
    await finishNext(h, 3);

    h.core.nextLesson();
    await h.settle();

    // Opened, 02 is tried again; and this time its failure is the learner's to see.
    expect(converting(h, course)).toEqual(['01', '02', '03', '04', '02']);
    h.converter.requests[4]?.fail('ffmpeg exited with code 1: Invalid data');
    await h.settle();
    expect(h.player.sent.filter((command) => command.type === 'soundFailed')).toHaveLength(1);
  });

  it('gives up a Lesson ahead that makes no progress for 60 seconds, and shows nothing', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(3));
    await finishNext(h, 0);
    h.converter.requests[1]?.progress(10);

    h.clock.advance(60_000);
    await h.settle();

    expect(h.converter.requests[1]?.request.signal.aborted).toBe(true);
    expect(converting(h, course)).toEqual(['01', '02', '03']);
    expect(h.ui.messages).toEqual([]);
    expect(h.player.sent.filter((command) => command.type === 'soundFailed')).toEqual([]);
  });

  it('still shows the failure of the opened Lesson, and then prepares the next Lessons', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(3));

    h.converter.requests[0]?.fail('ffmpeg exited with code 1: Invalid data');
    await h.settle();

    expect(h.player.sent.filter((command) => command.type === 'soundFailed')).toHaveLength(1);
    expect(converting(h, course)).toEqual(['01', '02']);
  });

  it('stops the work ahead when the learner closes the player', async () => {
    const h = await createHarness();
    await openCourse(h, lessons(4));
    await finishNext(h, 0);
    const ahead = h.converter.requests[1];

    h.player.close();
    await h.settle();

    expect(ahead?.request.signal.aborted).toBe(true);
    expect(h.converter.requests).toHaveLength(2);
  });

  it('stops the work ahead for a Course the learner leaves, and starts the new Course from its first Lesson', async () => {
    const h = await createHarness();
    await openCourse(h, lessons(4), 'first');
    await finishNext(h, 0);
    const ahead = h.converter.requests[1];
    const other = await h.folder('second', lessons(2));

    await h.core.openCourse(other);
    h.player.ready(false);
    await h.settle();

    expect(ahead?.request.signal.aborted).toBe(true);
    expect(h.converter.requests).toHaveLength(3);
    expect(h.converter.requests[2]?.request.input).toBe(join(other, '01 Lesson.mp4'));
  });

  it('stops the work ahead when the window closes', async () => {
    const h = await createHarness();
    await openCourse(h, lessons(4));
    await finishNext(h, 0);
    const ahead = h.converter.requests[1];

    await h.core.close();

    expect(ahead?.request.signal.aborted).toBe(true);
  });

  it('stops the work ahead when the learner jumps to a Lesson that needs no sound', async () => {
    const h = await createHarness();
    const course = await openCourse(h, { ...lessons(4), '08 Lesson.webm': 'webm video' });
    await finishNext(h, 0);
    const ahead = h.converter.requests[1];

    h.core.playLesson('08 Lesson.webm');
    await h.settle();

    expect(ahead?.request.signal.aborted).toBe(true);
    expect(converting(h, course)).toEqual(['01', '02']);
  });

  it('gives the opened Lesson its turn before a Lesson still wanted ahead, which then starts again', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(5));
    h.core.playLesson('02 Lesson.mp4');
    await h.settle();
    await finishNext(h, 1);
    const ahead = h.converter.requests[2];
    expect(converting(h, course)).toEqual(['01', '02', '03']);

    // 03 is still among the 3 after 01, but the opened Lesson is first.
    h.core.playLesson('01 Lesson.mp4');
    await h.settle();

    expect(ahead?.request.signal.aborted).toBe(true);
    expect(converting(h, course)).toEqual(['01', '02', '03', '01']);
    await finishNext(h, 3);
    expect(converting(h, course)).toEqual(['01', '02', '03', '01', '03']);
  });

  it('prepares a sound again that was taken away since, when the learner moves on', async () => {
    const h = await createHarness();
    const course = await openCourse(h, lessons(6));
    for (const index of [0, 1, 2, 3]) {
      await finishNext(h, index);
    }
    expect(converting(h, course)).toEqual(['01', '02', '03', '04']);
    // The sound of 03 is gone: cleared by hand, or pruned to make room.
    const sounds = join(course, '.followalong', 'sound');
    const third = (await h.listFiles(sounds)).find((file) => file.startsWith('03 Lesson-'));
    await rm(join(sounds, third ?? ''));

    h.core.nextLesson();
    await h.settle();

    // 02 is open: 03 is among its next 3 again, and 04 and 05 follow it.
    expect(converting(h, course)).toEqual(['01', '02', '03', '04', '03']);
    await finishNext(h, 4);
    expect(converting(h, course)).toEqual(['01', '02', '03', '04', '03', '05']);
  });
});
