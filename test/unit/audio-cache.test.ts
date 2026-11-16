/**
 * The audio cache limit (spec #12, Sound for MP4 Lessons, story 74; ticket #45): prepared sound
 * files are capped (5 GB by default), and the Lessons opened longest ago are deleted first. The fake
 * converter writes 13-byte MP3s, so a limit of a few dozen bytes stands for a small disk.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, fakeSound, type Harness } from './harness.js';
import { makeReadOnly } from './read-only.js';

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

/** The Lessons whose sound is kept in the extension's own storage, as the Courses' numbers. */
async function keptInStorage(h: Harness): Promise<string[]> {
  const root = join(h.storage.folder, 'courses');
  const courses = await readdir(root).catch(() => []);
  const names = await Promise.all(
    courses.map((course) => readdir(join(root, course, 'sound')).catch(() => [])),
  );
  return names
    .flat()
    .filter((name) => name.endsWith('.mp3'))
    .map((name) => name.slice(0, 2))
    .sort();
}

/** The name of the file that holds Lesson `number`'s sound in `course`'s sound folder. */
async function soundOf(course: string, number: string): Promise<string> {
  const names = await readdir(join(course, '.followalong', 'sound'));
  const found = names.find((name) => name.startsWith(number));
  if (found === undefined) {
    throw new Error(`No sound file for Lesson ${number}`);
  }
  return found;
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

  it('counts the sound of every Course, in its folder and in the extension’s own storage', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', limitOf(mp3Bytes));
    const first = await openCourse(h, 'first', 1);
    await finishAll(h);
    expect(await kept(first)).toEqual(['01']);
    h.clock.advance(60_000);

    // A read-only Course keeps its sound in the extension's storage; the older sound of the first
    // Course, in its own folder, makes way for it.
    const second = await h.folder('second', lessons(1));
    makeReadOnly(second);
    await h.core.openCourse(second);
    h.player.ready(false);
    await h.settle();
    await finishAll(h);
    expect(await kept(first)).toEqual([]);
    expect(await keptInStorage(h)).toEqual(['01']);
    h.clock.advance(60_000);

    // And the other way round: a Course with a writable folder pushes out older sound in storage.
    const third = await openCourse(h, 'third', 1);
    await finishAll(h);
    expect(await keptInStorage(h)).toEqual([]);
    expect(await kept(third)).toEqual(['01']);
    expect(h.ui.messages).toEqual([]);
  });

  it('never deletes the sound of the Lesson that is loaded or of the next Lessons being prepared', async () => {
    const h = await createHarness();
    // Not even one file fits: only what is in use stays.
    h.config.set('audioCacheLimit', 0);
    const course = await openCourse(h, 'course', 6);
    await finishAll(h);

    // The opened Lesson and the 3 after it are all in use.
    expect(await kept(course)).toEqual(['01', '02', '03', '04']);
    h.clock.advance(60_000);

    h.core.playLesson('06 Lesson.mp4');
    await finishAll(h);

    expect(await kept(course)).toEqual(['06']);
    const ready = h.player.sent.filter((command) => command.type === 'soundReady');
    expect(ready.at(-1)).toEqual({
      type: 'soundReady',
      audioUri: h.player.resourceUri(
        join(course, '.followalong', 'sound', await soundOf(course, '06')),
      ),
    });
  });
});
