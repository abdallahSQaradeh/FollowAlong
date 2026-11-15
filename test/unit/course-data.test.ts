import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openCourseData, type CourseDataFile } from '../../src/core/course-data.js';
import { createHarness } from './harness.js';
import { isHidden, makeReadOnly } from './read-only.js';

interface Notes {
  readonly lessons: Readonly<Record<string, string>>;
}

/** A versioned file as a later ticket would define one. Version 1 stored a single string. */
const notesFile: CourseDataFile<Notes> = {
  name: 'notes.json',
  version: 2,
  parse(data, version) {
    if (version === 1 && typeof data === 'string') {
      return { lessons: { 'intro.webm': data } };
    }
    if (version === 2 && typeof data === 'object' && data !== null && 'lessons' in data) {
      return data as Notes;
    }
    return undefined;
  },
};

const notes: Notes = { lessons: { 'intro.webm': 'watched twice' } };

describe('Course data storage', () => {
  it("writes FollowAlong's data as versioned JSON into a hidden .followalong folder", async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'intro.webm': 'video' });

    await openCourseData(course, h.ports).write(notesFile, notes);

    expect(await h.listFiles(course)).toEqual(['.followalong/notes.json', 'intro.webm']);
    expect(isHidden(join(course, '.followalong'))).toBe(true);
    const stored: unknown = JSON.parse(
      await readFile(join(course, '.followalong', 'notes.json'), 'utf8'),
    );
    expect(stored).toEqual({ version: 2, data: notes });
    expect(h.ui.messages).toEqual([]);
  });

  it('reads back what was written, also after the Course is opened again', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'intro.webm': 'video' });
    await openCourseData(course, h.ports).write(notesFile, notes);

    expect(await openCourseData(course, h.ports).read(notesFile)).toEqual(notes);
  });

  it('reads nothing before anything was written', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { 'intro.webm': 'video' });

    expect(await openCourseData(course, h.ports).read(notesFile)).toBeUndefined();
    expect(await h.listFiles(course)).toEqual(['intro.webm']);
  });

  it('falls back to the extension storage, without an error, when the Course is read-only', async () => {
    const h = await createHarness();
    const course = await h.folder('read-only course', { 'intro.webm': 'video' });
    makeReadOnly(course);

    await openCourseData(course, h.ports).write(notesFile, notes);

    expect(await h.listFiles(course)).toEqual(['intro.webm']);
    expect(await h.listFiles(h.storage.folder)).toEqual([
      expect.stringMatching(/^courses\/read-only course-[0-9a-f]{16}\/notes\.json$/),
    ]);
    expect(await openCourseData(course, h.ports).read(notesFile)).toEqual(notes);
    expect(h.ui.messages).toEqual([]);
    expect(h.logger.entries).toContainEqual({
      level: 'info',
      message: `The Course folder ${course} is read-only; keeping FollowAlong's data for it in ${join(h.storage.folder, 'courses')}.`,
    });
  });

  it('keys the fallback storage by the Course’s absolute path', async () => {
    const h = await createHarness();
    const first = await h.folder('root A/Course', { 'intro.webm': 'video' });
    const second = await h.folder('root B/Course', { 'intro.webm': 'video' });
    makeReadOnly(first);
    makeReadOnly(second);

    await openCourseData(first, h.ports).write(notesFile, { lessons: { 'intro.webm': 'A' } });
    await openCourseData(second, h.ports).write(notesFile, { lessons: { 'intro.webm': 'B' } });

    expect(await openCourseData(first, h.ports).read(notesFile)).toEqual({
      lessons: { 'intro.webm': 'A' },
    });
    expect(await openCourseData(second, h.ports).read(notesFile)).toEqual({
      lessons: { 'intro.webm': 'B' },
    });
  });

  it('migrates a file written by an older version', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/notes.json': JSON.stringify({ version: 1, data: 'first note' }),
    });

    expect(await openCourseData(course, h.ports).read(notesFile)).toEqual({
      lessons: { 'intro.webm': 'first note' },
    });
  });

  it('ignores, with a warning in the log, a file it cannot read', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/notes.json': '{"version": 2, "data": ',
    });

    expect(await openCourseData(course, h.ports).read(notesFile)).toBeUndefined();
    expect(h.logger.entries).toContainEqual({
      level: 'warn',
      message: expect.stringContaining(
        `Ignoring ${join(course, '.followalong', 'notes.json')}: not valid JSON`,
      ) as unknown,
    });
  });

  it('ignores a file from a newer FollowAlong version', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/notes.json': JSON.stringify({ version: 3, data: { lessons: {} } }),
    });

    expect(await openCourseData(course, h.ports).read(notesFile)).toBeUndefined();
    expect(h.logger.entries).toContainEqual({
      level: 'warn',
      message: `Ignoring ${join(course, '.followalong', 'notes.json')}: it has version 3, newer than this FollowAlong understands (2).`,
    });
  });
});
