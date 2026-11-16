/**
 * Course data storage (spec #12, `.followalong\` folder; ADR 0005).
 *
 * FollowAlong keeps its own files for a Course (Progress, Resources, sound) in a hidden
 * `.followalong` folder inside the Course, and never changes anything else there. When the Course
 * folder is read-only, the same files go to the extension's storage instead, in a folder keyed by
 * the Course's absolute path; that is only logged, never shown as an error.
 *
 * Each file is versioned JSON, `{ "version": n, "data": … }`, so later versions can migrate it.
 * The folder is created on the first write, so opening a Course leaves it untouched.
 */
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

import { FileSystemError, type Ports } from './ports.js';

export const courseDataFolderName = '.followalong';

/** One versioned JSON file of Course data. */
export interface CourseDataFile<T> {
  readonly name: string;
  /** The version this FollowAlong writes. */
  readonly version: number;
  /** Turns stored data of `version` (at most the current one) into `T`, or `undefined`. */
  parse(data: unknown, version: number): T | undefined;
  /**
   * Combines the copies in `.followalong` and in the fallback storage, when both hold the file
   * (a Course that turned read-only after FollowAlong wrote to it). Without it, `read` returns the
   * copy of the location written last in this session, else the one in `.followalong`.
   */
  merge?(inCourse: T, inFallback: T): T;
}

/**
 * A write refused because the file it would replace exists but could not be read (damaged, from a
 * newer FollowAlong, or not readable): a newer FollowAlong may still read it (spec #12, D5).
 */
export class UnreadableCourseDataError extends Error {
  override readonly name = 'UnreadableCourseDataError';

  constructor(readonly path: string) {
    super(`${path} cannot be read, so FollowAlong does not write over it.`);
  }
}

export interface CourseData {
  read<T>(file: CourseDataFile<T>): Promise<T | undefined>;
  /**
   * Rejects with {@link UnreadableCourseDataError} instead of replacing a copy that this store
   * read and could not use.
   */
  write<T>(file: CourseDataFile<T>, value: T): Promise<void>;
}

type CourseDataPorts = Pick<Ports, 'fileSystem' | 'storage' | 'logger'>;

/** `<storage>/courses/<folder name>-<hash of the absolute path>`: readable, and unique per path. */
function fallbackFolder(course: string, storageFolder: string): string {
  const hash = createHash('sha256').update(course).digest('hex').slice(0, 16);
  const name = basename(course)
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .slice(0, 60);
  return join(storageFolder, 'courses', `${name}-${hash}`);
}

/** `course` is the Course folder's absolute path, which also keys the fallback storage. */
export function openCourseData(course: string, ports: CourseDataPorts): CourseData {
  const { fileSystem, storage, logger } = ports;
  const inCourse = join(course, courseDataFolderName);
  const fallback = fallbackFolder(course, storage.folder);
  /** Where writes go, decided by the first write. */
  let target: string | undefined;
  /** Folders already created (and hidden) by this store, so later writes skip that step. */
  const prepared = new Set<string>();
  /** Copies read and found unusable: writes never replace them (spec #12, D5). */
  const unreadable = new Set<string>();

  /** The file's value in `location`; a file that exists but cannot be used is never written over. */
  async function readFrom<T>(location: string, file: CourseDataFile<T>): Promise<T | undefined> {
    const path = join(location, file.name);
    const ignore = (why: string): void => {
      unreadable.add(path);
      logger.log({ level: 'warn', message: `Ignoring ${path}: ${why}` });
    };
    let text: string;
    try {
      text = await fileSystem.readText(path);
    } catch (error) {
      if (FileSystemError.is(error, 'notFound')) {
        return undefined;
      }
      ignore(`it cannot be read (${error instanceof Error ? error.message : String(error)}).`);
      return undefined;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch (error) {
      ignore(`not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
      return undefined;
    }
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('version' in stored) ||
      !('data' in stored) ||
      typeof stored.version !== 'number' ||
      !Number.isInteger(stored.version)
    ) {
      ignore('it is not a versioned FollowAlong file.');
      return undefined;
    }
    if (stored.version > file.version) {
      ignore(
        `it has version ${String(stored.version)}, newer than this FollowAlong understands (${String(file.version)}).`,
      );
      return undefined;
    }
    const value = file.parse(stored.data, stored.version);
    if (value === undefined) {
      ignore(`its version ${String(stored.version)} data is not in the expected shape.`);
    }
    return value;
  }

  async function writeTo(location: string, name: string, content: string) {
    const path = join(location, name);
    if (unreadable.has(path)) {
      throw new UnreadableCourseDataError(path);
    }
    if (!prepared.has(location)) {
      // Only `.followalong` itself is made in the Course: were the Course folder gone (moved while
      // open), making its parents would bring back an empty Course at the old path.
      const inTheCourse = location === inCourse;
      await fileSystem.makeDirectory(location, { hidden: inTheCourse, parents: !inTheCourse });
      prepared.add(location);
    }
    await fileSystem.writeText(path, content);
  }

  function useFallback(): void {
    target = fallback;
    logger.log({
      level: 'info',
      message: `The Course folder ${course} is read-only; keeping FollowAlong's data for it in ${join(storage.folder, 'courses')}.`,
    });
  }

  return {
    async read<T>(file: CourseDataFile<T>): Promise<T | undefined> {
      if (file.merge !== undefined) {
        const inCourseCopy = await readFrom(inCourse, file);
        const fallbackCopy = await readFrom(fallback, file);
        return inCourseCopy === undefined || fallbackCopy === undefined
          ? (inCourseCopy ?? fallbackCopy)
          : file.merge(inCourseCopy, fallbackCopy);
      }
      // After a fall back, the fallback copy is the newer one; .followalong may still hold the rest.
      const locations = target === fallback ? [fallback, inCourse] : [inCourse, fallback];
      for (const location of locations) {
        const value = await readFrom(location, file);
        if (value !== undefined) {
          return value;
        }
      }
      return undefined;
    },

    async write<T>(file: CourseDataFile<T>, value: T): Promise<void> {
      const content = `${JSON.stringify({ version: file.version, data: value }, null, 2)}\n`;
      if (target !== fallback) {
        try {
          await writeTo(inCourse, file.name, content);
          target = inCourse;
          return undefined;
        } catch (error) {
          if (!FileSystemError.is(error, 'readOnly')) {
            throw error;
          }
          useFallback();
        }
      }
      await writeTo(fallback, file.name, content);
    },
  };
}
