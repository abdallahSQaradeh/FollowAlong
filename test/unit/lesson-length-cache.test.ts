import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { folderKey } from '../../src/core/folder-identity.js';
import {
  cachedLessonLength,
  cachedLessonLengths,
  lessonLengthCacheCourses,
  saveLessonLengths,
} from '../../src/core/lesson-length-cache.js';
import { createHarness } from './harness.js';

const intro = { size: 1000, modifiedMs: 5000 };
const part = { size: 2000, modifiedMs: 6000 };

describe('the Lesson length cache', () => {
  it('gives back, in a new window, the lengths a probe found', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.mp4': 'v', 'part.mp4': 'v' });

    await saveLessonLengths(
      h,
      course,
      new Map([
        ['intro.mp4', { ...intro, seconds: 600 }],
        ['part.mp4', { ...part, seconds: undefined }],
      ]),
    );
    h.restart();

    expect(cachedLessonLengths(h.storage.global, course)).toEqual(new Map([['intro.mp4', 600]]));
    expect(cachedLessonLength(h.storage.global, course, 'intro.mp4', intro)).toEqual({
      seconds: 600,
    });
    expect(cachedLessonLength(h.storage.global, course, 'part.mp4', part)).toEqual({
      seconds: undefined,
    });
  });

  it('has nothing for a Lesson whose file changed since it was probed', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.mp4': 'v' });
    await saveLessonLengths(h, course, new Map([['intro.mp4', { ...intro, seconds: 600 }]]));

    expect(
      cachedLessonLength(h.storage.global, course, 'intro.mp4', { ...intro, size: 1001 }),
    ).toBeUndefined();
    expect(
      cachedLessonLength(h.storage.global, course, 'intro.mp4', { ...intro, modifiedMs: 5001 }),
    ).toBeUndefined();
  });

  it('says in the log, once, that it could not save, and does not fail the caller', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.mp4': 'v' });
    h.failNextWrite('global', 'disk full');

    await expect(
      saveLessonLengths(h, course, new Map([['intro.mp4', { ...intro, seconds: 600 }]])),
    ).resolves.toBeUndefined();

    const warnings = h.logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('disk full');
    expect(cachedLessonLengths(h.storage.global, course)).toEqual(new Map());
  });

  it('keeps only the Courses saved most recently, dropping the oldest past the limit', async () => {
    const h = await createHarness();
    const library = await h.folder('Library', { 'readme.txt': 'r' });
    const courseAt = (index: number): string => join(library, `Course ${String(index)}`);
    const save = (index: number): Promise<void> =>
      saveLessonLengths(h, courseAt(index), new Map([['intro.mp4', { ...intro, seconds: 600 }]]));
    for (let index = 0; index < lessonLengthCacheCourses; index += 1) {
      await save(index);
    }
    await save(0);

    await save(lessonLengthCacheCourses);

    const known = (index: number): number =>
      cachedLessonLengths(h.storage.global, courseAt(index)).size;
    expect(known(0)).toBe(1);
    expect(known(1)).toBe(0);
    expect(known(2)).toBe(1);
    expect(known(lessonLengthCacheCourses)).toBe(1);
  });

  it('ignores a cache of another version', async () => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.mp4': 'v' });
    await saveLessonLengths(h, course, new Map([['intro.mp4', { ...intro, seconds: 600 }]]));
    const saved = h.storage.global.get('lessonLengths') as Record<string, unknown>;
    await h.storage.global.set('lessonLengths', { ...saved, version: 99 });

    expect(cachedLessonLengths(h.storage.global, course)).toEqual(new Map());
    expect(cachedLessonLength(h.storage.global, course, 'intro.mp4', intro)).toBeUndefined();
  });

  it.each<[string, (folder: string) => unknown]>([
    ['not an object', () => 'nonsense'],
    ['Courses that are not a list', () => ({ version: 1, courses: 'nonsense' })],
    ['a Course with no folder', () => ({ version: 1, courses: [{ lessons: {} }] })],
    ['Lessons that are not an object', (folder) => ({ version: 1, courses: [{ folder }] })],
    [
      'a length that is not a number',
      (folder) => ({
        version: 1,
        courses: [{ folder, lessons: { 'intro.mp4': { ...intro, seconds: '600' } } }],
      }),
    ],
    [
      'a Lesson with no stat',
      (folder) => ({
        version: 1,
        courses: [{ folder, lessons: { 'intro.mp4': { seconds: 600 } } }],
      }),
    ],
  ])('ignores a damaged cache (%s) and saves over it', async (_, damaged) => {
    const h = await createHarness();
    const course = await h.folder('Course', { 'intro.mp4': 'v', 'part.mp4': 'v' });
    await h.storage.global.set('lessonLengths', damaged(folderKey(course)));

    expect(cachedLessonLengths(h.storage.global, course)).toEqual(new Map());
    expect(cachedLessonLength(h.storage.global, course, 'intro.mp4', intro)).toBeUndefined();
    await saveLessonLengths(h, course, new Map([['part.mp4', { ...part, seconds: 90 }]]));
    expect(cachedLessonLengths(h.storage.global, course)).toEqual(new Map([['part.mp4', 90]]));
  });
});
