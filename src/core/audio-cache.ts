/**
 * The audio cache (spec #12, Sound for MP4 Lessons, stories 74 and 75; ADR 0096): the prepared
 * sound files of every Course on this machine, in Course data (`.followalong/sound`) and in the
 * fallback storage of read-only Courses. Together they stay under a size limit (5 GB by default),
 * and the Lessons opened longest ago lose their sound first; `Clear audio cache` deletes them all.
 *
 * What the cache knows of the files it does not look at is a record in the global storage: each
 * sound file's path and when its Lesson was last opened. Sound files found by looking in the
 * folders of the open Course and in the fallback storage are added to it, with the day they were
 * made as the day they were opened.
 */
import { join } from 'node:path';

import { fallbackRoot } from './course-data.js';
import { keyOf } from './courses-roots.js';
import { messageOf } from './logger.js';
import { FileSystemError, type Ports } from './ports.js';

/** The Course data subfolder that holds prepared sound. */
export const soundFolderName = 'sound';

/** Global storage key of the record. */
const recordKey = 'audioCache';

/** The shape of the stored record; another version is ignored, and found again by looking. */
const recordVersion = 1;

/** The limit, in GB, when the setting is not a number of at least 0. */
const defaultLimitGb = 5;

const bytesPerGb = 1024 ** 3;

/** What the open Course tells the cache, when the cache looks: which sound files are in use. */
export interface AudioCacheUse {
  /** The Course's sound folders (in `.followalong` and in the fallback storage). */
  readonly soundFolders: readonly string[];
  /** The sound files of the Lesson that is loaded, whichever folder it is in. */
  readonly loaded: readonly string[];
  /** The sound files of the Lessons the queue prepares for the learner to open next. */
  readonly ahead: readonly string[];
}

export interface ClearResult {
  readonly removed: number;
  readonly bytes: number;
}

export interface AudioCache {
  /** A sound file was made at `path`: it is known from now on, as opened now if it was not. */
  made(path: string): void;
  /** The learner opened the Lesson whose sound is at `path`: it is the newest one. */
  opened(path: string): void;
  /**
   * Looks at the cache in the background and deletes the sound of the Lessons opened longest ago
   * until it is under the limit. Never throws and never waits: playback does not depend on it.
   */
  prune(): void;
  /**
   * `FollowAlong: Clear audio cache`: deletes every prepared sound file but the loaded Lesson's,
   * says how many, and resolves once done.
   */
  clear(): Promise<ClearResult>;
  /**
   * The open Course says which sound files are in use, whenever the cache looks. Returns the call
   * that takes it back (only if it is still the one that is followed).
   */
  follow(source: () => Promise<AudioCacheUse>): () => void;
}

interface Known {
  readonly path: string;
  readonly openedMs: number;
}

interface Found extends Known {
  readonly size: number;
}

/** The size of the cache as the learner reads it. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} byte${bytes === 1 ? '' : 's'}`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** The limit in bytes: the setting is in GB; anything that is not a number of at least 0 is 5. */
function limitBytes(setting: unknown): number {
  const gb =
    typeof setting === 'number' && Number.isFinite(setting) && setting >= 0
      ? setting
      : defaultLimitGb;
  return gb * bytesPerGb;
}

function isKnown(value: unknown): value is Known {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<Record<keyof Known, unknown>>;
  return (
    typeof entry.path === 'string' &&
    entry.path !== '' &&
    typeof entry.openedMs === 'number' &&
    Number.isFinite(entry.openedMs)
  );
}

const nothingInUse: AudioCacheUse = { soundFolders: [], loaded: [], ahead: [] };

export function createAudioCache(
  ports: Pick<Ports, 'fileSystem' | 'storage' | 'clock' | 'config' | 'logger' | 'ui'>,
): AudioCache {
  const { fileSystem, storage, clock, config, logger, ui } = ports;
  let source: (() => Promise<AudioCacheUse>) | undefined;
  /** Everything the cache does goes one after the other, so no change to the record is lost. */
  let chain: Promise<unknown> = Promise.resolve();

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  function readRecord(): Map<string, Known> {
    const stored: unknown = storage.global.get(recordKey);
    const files =
      typeof stored === 'object' && stored !== null && 'version' in stored && 'files' in stored
        ? stored
        : undefined;
    const known = new Map<string, Known>();
    if (files?.version === recordVersion && Array.isArray(files.files)) {
      for (const entry of files.files as unknown[]) {
        if (isKnown(entry)) {
          known.set(keyOf(entry.path), { path: entry.path, openedMs: entry.openedMs });
        }
      }
    }
    return known;
  }

  async function writeRecord(known: ReadonlyMap<string, Known>): Promise<void> {
    await storage.global.set(recordKey, {
      version: recordVersion,
      files: [...known.values()].map(({ path, openedMs }) => ({ path, openedMs })),
    });
  }

  /** The `.mp3` files in `folder`, as paths; none if the folder is not there. */
  async function mp3sIn(folder: string, problems: string[]): Promise<string[]> {
    try {
      const entries = await fileSystem.readDirectory(folder);
      return entries
        .filter((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.mp3'))
        .map((entry) => join(folder, entry.name));
    } catch (error) {
      if (!FileSystemError.is(error, 'notFound')) {
        problems.push(`${folder}: ${messageOf(error)}`);
      }
      return [];
    }
  }

  /** The sound folders of the fallback storage: one per Course that could not keep its data. */
  async function fallbackSoundFolders(problems: string[]): Promise<string[]> {
    const root = fallbackRoot(storage.folder);
    try {
      const entries = await fileSystem.readDirectory(root);
      return entries
        .filter((entry) => entry.kind === 'directory')
        .map((entry) => join(root, entry.name, soundFolderName));
    } catch (error) {
      if (!FileSystemError.is(error, 'notFound')) {
        problems.push(`${root}: ${messageOf(error)}`);
      }
      return [];
    }
  }

  /**
   * Every sound file that is there, with its size and when it was opened. Files the record has
   * and that are gone are dropped from it; files found by looking and not in it are added.
   */
  async function look(
    use: AudioCacheUse,
    problems: string[],
  ): Promise<{ readonly files: Found[]; readonly known: Map<string, Known> }> {
    const known = readRecord();
    const folders = [...(await fallbackSoundFolders(problems)), ...use.soundFolders];
    const paths = new Map<string, string>();
    for (const path of [...[...known.values()].map((entry) => entry.path)]) {
      paths.set(keyOf(path), path);
    }
    for (const folder of folders) {
      for (const path of await mp3sIn(folder, problems)) {
        if (!paths.has(keyOf(path))) {
          paths.set(keyOf(path), path);
        }
      }
    }
    const files: Found[] = [];
    for (const [key, path] of paths) {
      try {
        const { size, modifiedMs } = await fileSystem.stat(path);
        const entry = known.get(key) ?? { path, openedMs: modifiedMs };
        known.set(key, entry);
        files.push({ ...entry, size });
      } catch (error) {
        if (FileSystemError.is(error, 'notFound')) {
          known.delete(key);
        } else {
          problems.push(`${path}: ${messageOf(error)}`);
        }
      }
    }
    return { files, known };
  }

  /** Deletes `file`; resolves with whether it is gone. */
  async function remove(file: Found, problems: string[]): Promise<boolean> {
    try {
      await fileSystem.remove(file.path);
      return true;
    } catch (error) {
      if (FileSystemError.is(error, 'notFound')) {
        return true;
      }
      problems.push(`${file.path}: ${messageOf(error)}`);
      return false;
    }
  }

  /** One line for everything that went wrong in one go. */
  function reportProblems(what: string, problems: readonly string[]): void {
    const first = problems[0];
    if (first !== undefined) {
      const more = problems.length > 1 ? ` (and ${String(problems.length - 1)} more)` : '';
      logger.log({ level: 'warn', message: `${what}: ${first}${more}` });
    }
  }

  /** Deletes the files `choose` picks, oldest opened first; resolves with what went. */
  async function deleteFrom(
    use: AudioCacheUse,
    choose: (files: Found[]) => Found[],
    problems: string[],
  ): Promise<ClearResult> {
    const { files, known } = await look(use, problems);
    let removed = 0;
    let bytes = 0;
    for (const file of choose(files)) {
      if (await remove(file, problems)) {
        known.delete(keyOf(file.path));
        removed += 1;
        bytes += file.size;
      }
    }
    await writeRecord(known);
    return { removed, bytes };
  }

  async function pruneNow(): Promise<void> {
    const use = (await source?.()) ?? nothingInUse;
    const limit = limitBytes(config.get('audioCacheLimit'));
    const protectedKeys = new Set([...use.loaded, ...use.ahead].map(keyOf));
    const problems: string[] = [];
    const result = await deleteFrom(
      use,
      (files) => {
        let total = files.reduce((sum, file) => sum + file.size, 0);
        const chosen: Found[] = [];
        const oldestFirst = files
          .filter((file) => !protectedKeys.has(keyOf(file.path)))
          .sort((a, b) => a.openedMs - b.openedMs || a.path.localeCompare(b.path));
        for (const file of oldestFirst) {
          if (total <= limit) {
            break;
          }
          chosen.push(file);
          total -= file.size;
        }
        return chosen;
      },
      problems,
    );
    if (result.removed > 0) {
      logger.log({
        level: 'info',
        message: `Deleted ${String(result.removed)} prepared sound files (${sizeText(result.bytes)}) to stay under the audio cache limit.`,
      });
    }
    reportProblems('Could not keep the audio cache under its limit', problems);
  }

  async function clearNow(): Promise<ClearResult> {
    const use = (await source?.()) ?? nothingInUse;
    const loaded = new Set(use.loaded.map(keyOf));
    const problems: string[] = [];
    const result = await deleteFrom(
      use,
      (files) => files.filter((file) => !loaded.has(keyOf(file.path))),
      problems,
    );
    reportProblems('Could not clear all of the audio cache', problems);
    const kept =
      use.loaded.length > 0 && problems.length === 0 ? ' The open Lesson’s sound stays.' : '';
    ui.showMessage(
      problems.length > 0
        ? {
            severity: 'warning',
            text: `FollowAlong deleted ${String(result.removed)} prepared sound files (${sizeText(result.bytes)}), but could not delete the others. See the FollowAlong output.`,
          }
        : {
            severity: 'info',
            text:
              result.removed === 0
                ? `The audio cache is empty: no prepared sound to delete.${kept}`
                : `FollowAlong deleted ${String(result.removed)} prepared sound file${result.removed === 1 ? '' : 's'} (${sizeText(result.bytes)}).${kept}`,
          },
    );
    return result;
  }

  /** Records `path` as opened at `atMs`, or, with `onlyNew`, only if the record lacks it. */
  function record(path: string, atMs: number, onlyNew: boolean): void {
    void exclusive(async () => {
      const known = readRecord();
      if (!onlyNew || !known.has(keyOf(path))) {
        known.set(keyOf(path), { path, openedMs: atMs });
        await writeRecord(known);
      }
    }).catch((error: unknown) => {
      logger.log({
        level: 'warn',
        message: `Could not note a prepared sound in the audio cache: ${messageOf(error)}`,
      });
    });
  }

  return {
    made: (path) => {
      record(path, clock.now(), true);
    },
    opened: (path) => {
      record(path, clock.now(), false);
    },
    prune() {
      void exclusive(pruneNow).catch((error: unknown) => {
        logger.log({
          level: 'warn',
          message: `Could not keep the audio cache under its limit: ${messageOf(error)}`,
        });
      });
    },
    clear: () => exclusive(clearNow),
    follow(next) {
      source = next;
      return () => {
        if (source === next) {
          source = undefined;
        }
      };
    },
  };
}
