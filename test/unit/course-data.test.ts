import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  openCourseData,
  UnreadableCourseDataError,
  type CourseDataFile,
} from '../../src/core/course-data.js';
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

const otherFile: CourseDataFile<string> = {
  name: 'other.json',
  version: 1,
  parse: (data) => (typeof data === 'string' ? data : undefined),
};

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

  it('ignores a file it cannot read', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/notes.json': '{"version": 2, "data": ',
    });

    expect(await openCourseData(course, h.ports).read(notesFile)).toBeUndefined();
    expect(h.ui.messages).toEqual([]);
  });

  it('ignores a file from a newer FollowAlong version', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/notes.json': JSON.stringify({ version: 3, data: { lessons: {} } }),
    });

    expect(await openCourseData(course, h.ports).read(notesFile)).toBeUndefined();
  });

  it('still reads what .followalong holds after later writes fell back', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/notes.json': JSON.stringify({ version: 2, data: notes }),
    });
    makeReadOnly(join(course, '.followalong'));
    const data = openCourseData(course, h.ports);

    await data.write(otherFile, 'kept elsewhere');

    expect(await data.read(otherFile)).toBe('kept elsewhere');
    expect(await data.read(notesFile)).toEqual(notes);
    expect(await h.listFiles(course)).toEqual(['.followalong/notes.json']);
  });

  it('hides a .followalong folder that exists but is not hidden yet', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '.followalong/readme.txt': 'made by hand' });

    await openCourseData(course, h.ports).write(notesFile, notes);

    expect(isHidden(join(course, '.followalong'))).toBe(true);
  });

  it('falls back to the extension storage when .followalong is a file, not a folder', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '.followalong': 'not a folder', 'intro.webm': 'v' });

    await openCourseData(course, h.ports).write(notesFile, notes);

    expect(await h.listFiles(course)).toEqual(['.followalong', 'intro.webm']);
    expect(await openCourseData(course, h.ports).read(notesFile)).toEqual(notes);
    expect(h.ui.messages).toEqual([]);
  });

  it('writes again once a file it could not read has been fixed', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '.followalong/notes.json': '{"version": 2' });
    const data = openCourseData(course, h.ports);
    expect(await data.read(notesFile)).toBeUndefined();
    await expect(data.write(notesFile, notes)).rejects.toThrow(UnreadableCourseDataError);

    await writeFile(
      join(course, '.followalong', 'notes.json'),
      JSON.stringify({ version: 2, data: notes }),
    );
    expect(await data.read(notesFile)).toEqual(notes);
    await data.write(notesFile, { lessons: { 'intro.webm': 'fixed' } });

    expect(await openCourseData(course, h.ports).read(notesFile)).toEqual({
      lessons: { 'intro.webm': 'fixed' },
    });
  });

  it('never writes over a fallback copy it could not read, even one it has not read yet', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '.followalong/notes.json': JSON.stringify({ version: 2, data: notes }),
    });
    makeReadOnly(join(course, '.followalong'));
    await openCourseData(course, h.ports).write(notesFile, notes);
    const [fallbackCopy] = await h.listFiles(h.storage.folder);
    const damaged = join(h.storage.folder, fallbackCopy ?? '');
    await writeFile(damaged, '{"version": 99, "data": {}}');

    // The copy in the Course is usable, so a read stops there; the write must still not replace
    // the fallback copy, which a newer FollowAlong wrote.
    const data = openCourseData(course, h.ports);
    expect(await data.read(notesFile)).toEqual(notes);
    await expect(data.write(notesFile, notes)).rejects.toThrow(UnreadableCourseDataError);

    expect(await readFile(damaged, 'utf8')).toBe('{"version": 99, "data": {}}');
  });
});
