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

/** Where a write went, when it was not where it would usually go. */
export interface CourseDataWritten<T> {
  /**
   * The copy in `.followalong` could not be read, so it was left as it was and the data went to the
   * fallback storage instead (spec #12, D5 as amended); reads then use the fallback copy.
   */
  readonly keptElsewhere?: string;
  /**
   * What was written, when it is more than the value given: a copy whose earlier read had failed
   * could be read now, and its data was merged in (`CourseDataFile.merge`) rather than replaced.
   */
  readonly merged?: T;
}

export interface CourseData {
  read<T>(file: CourseDataFile<T>): Promise<T | undefined>;
  /**
   * Never replaces a copy this store read and could not use. Such a copy in `.followalong` sends the
   * data to the fallback storage; such a copy where the data must go rejects with
   * {@link UnreadableCourseDataError}.
   */
  write<T>(file: CourseDataFile<T>, value: T): Promise<CourseDataWritten<T>>;
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
  /** Copies this store has read, and those it found unusable: writes never replace one (D5). */
  const seen = new Set<string>();
  const unreadable = new Set<string>();
  /** Of those, the copies whose read failed outright, rather than finding unusable content. */
  const failedToRead = new Set<string>();

  /** The file's value in `location`; a file that exists but cannot be used is never written over. */
  async function readFrom<T>(location: string, file: CourseDataFile<T>): Promise<T | undefined> {
    const path = join(location, file.name);
    const wasUnreadable = unreadable.has(path);
    seen.add(path);
    // What this read finds replaces what an earlier read found: a file fixed or removed since is
    // writable again.
    unreadable.delete(path);
    failedToRead.delete(path);
    const ignore = (why: string): void => {
      // Logged once while it stays unusable: a write reads a failing copy again every time.
      if (!wasUnreadable) {
        logger.log({ level: 'warn', message: `Ignoring ${path}: ${why}` });
      }
      unreadable.add(path);
    };
    let text: string;
    try {
      text = await fileSystem.readText(path);
    } catch (error) {
      if (FileSystemError.is(error, 'notFound')) {
        return undefined;
      }
      failedToRead.add(path);
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

  /** Writes `value` to `location`, and returns what was written when it had to merge a copy in. */
  async function writeTo<T>(
    location: string,
    file: CourseDataFile<T>,
    value: T,
  ): Promise<T | undefined> {
    const path = join(location, file.name);
    let merged: T | undefined;
    if (!seen.has(path) || failedToRead.has(path)) {
      // Never replace a file unseen: a read can stop at the other location's copy. A read that
      // failed (an antivirus scan holding the file, say) is tried again first.
      const hadFailed = failedToRead.has(path);
      const onDisk = await readFrom(location, file);
      if (hadFailed && onDisk !== undefined) {
        // Its data never reached the caller, so `value` lacks it: merge it in, never replace it.
        if (file.merge === undefined) {
          throw new UnreadableCourseDataError(path);
        }
        merged = file.merge(onDisk, value);
      }
    }
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
    const data = merged ?? value;
    await fileSystem.writeText(
      path,
      `${JSON.stringify({ version: file.version, data }, null, 2)}\n`,
    );
    return merged;
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

    async write<T>(file: CourseDataFile<T>, value: T): Promise<CourseDataWritten<T>> {
      const result = (merged: T | undefined, keptElsewhere?: string): CourseDataWritten<T> => ({
        ...(merged === undefined ? {} : { merged }),
        ...(keptElsewhere === undefined ? {} : { keptElsewhere }),
      });
      if (target !== fallback) {
        try {
          const merged = await writeTo(inCourse, file, value);
          target = inCourse;
          return result(merged);
        } catch (error) {
          if (error instanceof UnreadableCourseDataError) {
            // Left as it is, for whoever can read it; this data goes to the fallback for now.
            return result(await writeTo(fallback, file, value), error.path);
          }
          if (!FileSystemError.is(error, 'readOnly')) {
            throw error;
          }
          useFallback();
        }
      }
      return result(await writeTo(fallback, file, value));
    },
  };
}
