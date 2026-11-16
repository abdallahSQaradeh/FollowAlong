/**
 * The audio cache limit (spec #12, Sound for MP4 Lessons, story 74; ticket #45): prepared sound
 * files are capped (5 GB by default), and the Lessons opened longest ago are deleted first. The fake
 * converter writes 13-byte MP3s, so a limit of a few dozen bytes stands for a small disk.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, fakeSound, type Harness } from './harness.js';

const mp3Bytes = fakeSound.length;
const bytesPerGb = 1024 ** 3;

/** The setting is in GB: this is the value that stands for `bytes`. */
function limitOf(bytes: number): number {
  return bytes / bytesPerGb;
}

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
async function openCourse(h: Harness, name: string, count: number): Promise<string> {
  const course = await h.folder(name, lessons(count));
  await h.core.openCourse(course);
  h.player.ready(false);
  await h.settle();
  return course;
}

/** Succeeds every conversion that is waiting, and those the queue starts after them. */
async function finishAll(h: Harness): Promise<void> {
  for (let done = 0; ; done += 1) {
    await h.settle();
    const next = h.converter.requests[done];
    if (next === undefined) {
      return;
    }
    await next.succeed();
  }
}

/** The numbers of the Lessons whose sound is kept in `folder`'s Course data, in order. */
async function kept(course: string): Promise<string[]> {
  const folder = join(course, '.followalong', 'sound');
  const names = await readdir(folder).catch(() => []);
  return names
    .filter((name) => name.endsWith('.mp3'))
    .map((name) => name.slice(0, 2))
    .sort();
}

describe('the audio cache limit', () => {
  it('deletes the sound of the Lessons opened longest ago first, until it is under the limit', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', limitOf(5 * mp3Bytes));
    const course = await openCourse(h, 'course', 8);
    await finishAll(h);
    expect(await kept(course)).toEqual(['01', '02', '03', '04']);
    h.clock.advance(60_000);

    h.core.playLesson('06 Lesson.mp4');
    await finishAll(h);

    // 06 to 08 are in use or next; of the rest, 01 and 02 were opened longest ago.
    expect(await kept(course)).toEqual(['03', '04', '06', '07', '08']);
    expect(h.ui.messages).toEqual([]);
  });
});
