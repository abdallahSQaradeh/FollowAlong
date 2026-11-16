/**
 * Preparing sound ahead (spec #12, Sound for MP4 Lessons; ticket #44): after the opened Lesson's
 * sound is ready, the next 3 Lessons in Course order are converted one at a time, in the
 * background. Opening another Lesson reorders the queue and cancels what is no longer needed.
 */
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
});
