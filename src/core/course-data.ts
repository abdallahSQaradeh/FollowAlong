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
import { basename, join, resolve } from 'node:path';

import { FileSystemError, type Ports } from './ports.js';

export const courseDataFolderName = '.followalong';

/** One versioned JSON file of Course data. */
export interface CourseDataFile<T> {
  readonly name: string;
  /** The version this FollowAlong writes. */
  readonly version: number;
  /** Turns stored data of `version` (at most the current one) into `T`, or `undefined`. */
  parse(data: unknown, version: number): T | undefined;
}

export interface CourseData {
  read<T>(file: CourseDataFile<T>): Promise<T | undefined>;
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

function isReadOnly(error: unknown): boolean {
  return error instanceof FileSystemError && error.reason === 'readOnly';
}

export function openCourseData(folder: string, ports: CourseDataPorts): CourseData {
  const { fileSystem, storage, logger } = ports;
  const course = resolve(folder);
  const inCourse = join(course, courseDataFolderName);
  const fallback = fallbackFolder(course, storage.folder);
  /** Where writes go, decided by the first write. */
  let target: string | undefined;

  async function readFrom(location: string, file: CourseDataFile<unknown>): Promise<unknown> {
    const path = join(location, file.name);
    let text: string;
    try {
      text = await fileSystem.readText(path);
    } catch (error) {
      if (error instanceof FileSystemError && error.reason === 'notFound') {
        return undefined;
      }
      throw error;
    }
    const ignore = (why: string): void => {
      logger.log({ level: 'warn', message: `Ignoring ${path}: ${why}` });
    };
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

  async function writeTo(location: string, hidden: boolean, name: string, content: string) {
    await fileSystem.makeDirectory(location, { hidden });
    await fileSystem.writeText(join(location, name), content);
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
      const locations = target === undefined ? [inCourse, fallback] : [target];
      for (const location of locations) {
        const value = await readFrom(location, file);
        if (value !== undefined) {
          return value as T;
        }
      }
      return undefined;
    },

    async write<T>(file: CourseDataFile<T>, value: T): Promise<void> {
      const content = `${JSON.stringify({ version: file.version, data: value }, null, 2)}\n`;
      if (target !== fallback) {
        try {
          await writeTo(inCourse, true, file.name, content);
          target = inCourse;
          return undefined;
        } catch (error) {
          if (!isReadOnly(error)) {
            throw error;
          }
          useFallback();
        }
      }
      await writeTo(fallback, false, file.name, content);
    },
  };
}
