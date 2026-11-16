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

import { isInsideFolder, keyOf } from './courses-roots.js';
import { FileSystemError, type Ports, type ReleaseLock } from './ports.js';

export const courseDataFolderName = '.followalong';

/** One versioned JSON file of Course data. */
export interface CourseDataFile<T> {
  readonly name: string;
  /** The version this FollowAlong writes. */
  readonly version: number;
  /** Turns stored data of `version` (at most the current one) into `T`, or `undefined`. */
  parse(data: unknown, version: number): T | undefined;
  /**
   * Combines two copies of the file; `first` wins a tie. `read` merges the copies in `.followalong` and
   * in the fallback storage (a Course that turned read-only after FollowAlong wrote to it), and
   * `write` merges what it was given with the copy it replaces, read again under the file's lock
   * (another window may have written it, ADR 0074). Without it, `read` returns the copy of the
   * location written last in this session, else the one in `.followalong`.
   */
  merge?(first: T, second: T): T;
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

/**
 * A write not made because the file it would replace, which read fine until now, could not be read
 * for a moment (an antivirus scan holding it, say). Nothing was written anywhere: the caller keeps
 * its data and writes it again later (ADR 0074).
 */
export class CourseDataBusyError extends Error {
  override readonly name = 'CourseDataBusyError';

  constructor(readonly path: string) {
    super(`${path} could not be read just now.`);
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
   * What was written, for a file with `merge`: the value given merged with the copy it replaced
   * (another window's changes, or a copy whose earlier read had failed), so the caller can catch up.
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
  /**
   * The folders a subfolder of Course data (such as prepared sound) may be in, in the order reads
   * look in them: the one in `.followalong`, then the fallback one, or the other way round after a
   * fall back, as for files.
   */
  folders(name: string): readonly string[];
  /**
   * Makes the subfolder `name` where Course data goes now, and resolves with its path: in
   * `.followalong`, or in the fallback storage when the Course is read-only, as `write` decides.
   */
  prepareFolder(name: string): Promise<string>;
  /**
   * The subfolder `name` in `.followalong` turned out read-only after `prepareFolder` made it (it
   * was there already, written before the Course turned read-only): from now on Course data goes
   * to the fallback storage, as if the folder could not be made. Makes the fallback subfolder and
   * resolves with its path.
   */
  prepareFallbackFolder(name: string): Promise<string>;
}

type CourseDataPorts = Pick<Ports, 'fileSystem' | 'storage' | 'logger'>;

/**
 * `<storage>/courses`: where the fallback copies of every Course's data live. It is the same for
 * every Course, so the player may read prepared sound there without a page reload (ADR 0025).
 */
export function fallbackRoot(storageFolder: string): string {
  return join(storageFolder, 'courses');
}

/**
 * Whether `path` is a file FollowAlong writes itself: Course data in any Course's
 * `.followalong` folder, or anything in the extension's `storageFolder` (the fallback Course data).
 */
export function isCourseDataFile(path: string, storageFolder: string): boolean {
  const file = keyOf(path);
  return (
    file.split(/[\\/]/).includes(keyOf(courseDataFolderName)) ||
    isInsideFolder(keyOf(storageFolder), file)
  );
}

/** How many times a write reads a file again that read fine before and fails to read now. */
const rereadAttempts = 3;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<storage>/courses/<folder name>-<hash of the absolute path>`: readable, and unique per path. */
function fallbackFolder(course: string, storageFolder: string): string {
  const hash = createHash('sha256').update(course).digest('hex').slice(0, 16);
  const name = basename(course)
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .slice(0, 60);
  return join(fallbackRoot(storageFolder), `${name}-${hash}`);
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
      ignore(`it cannot be read (${messageOf(error)}).`);
      return undefined;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch (error) {
      ignore(`not valid JSON (${messageOf(error)}).`);
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

  /** Makes `location` once per store: hidden in the Course, with its parents in the fallback. */
  async function makeFolderOnce(location: string): Promise<void> {
    if (!prepared.has(location)) {
      // Only `.followalong` itself is made in the Course: were the Course folder gone (moved while
      // open), making its parents would bring back an empty Course at the old path.
      const inTheCourse = location === inCourse;
      await fileSystem.makeDirectory(location, { hidden: inTheCourse, parents: !inTheCourse });
      prepared.add(location);
    }
  }

  /**
   * Takes the lock of the file at `path` (ADR 0074), so that two windows on the Course never read
   * and rewrite it at the same time. A lock that cannot be made because the location is read-only
   * or gone fails like the write would; any other failure (held too long, say) is logged, and the
   * write goes ahead without it.
   */
  async function lockFile(path: string): Promise<ReleaseLock> {
    let release: ReleaseLock;
    try {
      release = await fileSystem.lock(path);
    } catch (error) {
      if (FileSystemError.is(error, 'readOnly') || FileSystemError.is(error, 'notFound')) {
        // The write itself would fail the same way: the caller falls back, or reports it.
        throw error;
      }
      logger.log({
        level: 'warn',
        message: `Writing ${path} without its lock: ${messageOf(error)}`,
      });
      return () => Promise.resolve();
    }
    return async () => {
      try {
        await release();
      } catch (error) {
        // Left on disk, it is taken over once it is old enough.
        logger.log({
          level: 'warn',
          message: `Could not give back the lock of ${path}: ${messageOf(error)}`,
        });
      }
    };
  }

  /**
   * Writes `value` to `location` under the file's lock. For a file with `merge`, resolves with what
   * was written when a copy was on disk to merge with; otherwise with `undefined`.
   */
  async function writeTo<T>(
    location: string,
    file: CourseDataFile<T>,
    value: T,
  ): Promise<T | undefined> {
    const path = join(location, file.name);
    await makeFolderOnce(location);
    const release = await lockFile(path);
    try {
      let merged: T | undefined;
      if (file.merge !== undefined) {
        // Another window on the same Course may have written the file since this store read it
        // (#27): read it again and merge, so what it added is kept. `value` comes first, where the
        // file's merge breaks a tie by order (Progress does not: D14).
        const failedBefore = failedToRead.has(path);
        let onDisk = await readFrom(location, file);
        for (let attempt = 1; attempt < rereadAttempts; attempt += 1) {
          if (failedBefore || !failedToRead.has(path)) {
            break;
          }
          onDisk = await readFrom(location, file);
        }
        if (!failedBefore && failedToRead.has(path)) {
          // It read fine until now: something holds it for a moment (an antivirus scan). Neither
          // written over nor sent elsewhere: this write is not made, and the next one reads again.
          throw new CourseDataBusyError(path);
        }
        if (onDisk !== undefined) {
          merged = file.merge(value, onDisk);
        }
      } else if (!seen.has(path) || failedToRead.has(path)) {
        // Never replace a file unseen: a read can stop at the other location's copy. A read that
        // failed (an antivirus scan holding the file, say) is tried again first.
        const hadFailed = failedToRead.has(path);
        const onDisk = await readFrom(location, file);
        if (hadFailed && onDisk !== undefined) {
          // Its data never reached the caller, so `value` lacks it, and it cannot be merged in.
          throw new UnreadableCourseDataError(path);
        }
      }
      if (unreadable.has(path)) {
        throw new UnreadableCourseDataError(path);
      }
      const data = merged ?? value;
      await fileSystem.writeText(
        path,
        `${JSON.stringify({ version: file.version, data }, null, 2)}\n`,
      );
      return merged;
    } finally {
      await release();
    }
  }

  /**
   * Where reads look, in order. After a fall back the fallback copy is the newer one, and
   * `.followalong` may still hold the rest.
   */
  function readOrder(): readonly string[] {
    return target === fallback ? [fallback, inCourse] : [inCourse, fallback];
  }

  function useFallback(): void {
    target = fallback;
    logger.log({
      level: 'info',
      message: `The Course folder ${course} is read-only; keeping FollowAlong's data for it in ${fallbackRoot(storage.folder)}.`,
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
      for (const location of readOrder()) {
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

    folders(name) {
      return readOrder().map((location) => join(location, name));
    },

    async prepareFolder(name) {
      if (target !== fallback) {
        try {
          await makeFolderOnce(inCourse);
          const folder = join(inCourse, name);
          await fileSystem.makeDirectory(folder, { hidden: false, parents: false });
          target = inCourse;
          return folder;
        } catch (error) {
          if (!FileSystemError.is(error, 'readOnly')) {
            throw error;
          }
          useFallback();
        }
      }
      const folder = join(fallback, name);
      await fileSystem.makeDirectory(folder, { hidden: false, parents: true });
      return folder;
    },

    async prepareFallbackFolder(name) {
      if (target !== fallback) {
        useFallback();
      }
      const folder = join(fallback, name);
      await fileSystem.makeDirectory(folder, { hidden: false, parents: true });
      return folder;
    },
  };
}
