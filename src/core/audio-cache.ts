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
import { FileSystemError, type DirectoryEntry, type Ports } from './ports.js';

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
  clear(): Promise<void>;
  /**
   * The open Course says which sound files are in use, whenever the cache looks. Returns the call
   * that takes it back (only if it is still the one that is followed).
   */
  follow(source: () => Promise<AudioCacheUse>): () => void;
}

/** A sound file the cache knows, and when its Lesson was last opened. */
interface OpenedFile {
  readonly path: string;
  readonly openedMs: number;
}

interface SoundFile extends OpenedFile {
  readonly size: number;
}

/** What deleting did: files gone, their bytes, and files left because they came into use. */
interface Deleted {
  readonly count: number;
  readonly bytes: number;
  readonly inUse: number;
}

/** The size of the cache as the learner reads it. */
function sizeText(bytes: number): string {
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

function isOpenedFile(value: unknown): value is OpenedFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<Record<keyof OpenedFile, unknown>>;
  return (
    typeof entry.path === 'string' &&
    entry.path !== '' &&
    typeof entry.openedMs === 'number' &&
    Number.isFinite(entry.openedMs)
  );
}

/** What is in use when nothing is: no Course is open. */
const nothingInUse: AudioCacheUse = { soundFolders: [], loaded: [], ahead: [] };

/** The deleting that each way of emptying the cache does. */
type Choose = (files: readonly SoundFile[]) => readonly SoundFile[];

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

  function readRecord(): Map<string, OpenedFile> {
    const stored: unknown = storage.global.get(recordKey);
    const record =
      typeof stored === 'object' && stored !== null && 'version' in stored && 'files' in stored
        ? stored
        : undefined;
    const opened = new Map<string, OpenedFile>();
    if (record?.version === recordVersion && Array.isArray(record.files)) {
      for (const entry of record.files as unknown[]) {
        if (isOpenedFile(entry)) {
          opened.set(keyOf(entry.path), { path: entry.path, openedMs: entry.openedMs });
        }
      }
    }
    return opened;
  }

  /** The record as it is stored: one text, so a record that did not change is not written. */
  function recordText(opened: ReadonlyMap<string, OpenedFile>): string {
    return JSON.stringify({
      version: recordVersion,
      files: [...opened.values()].map(({ path, openedMs }) => ({ path, openedMs })),
    });
  }

  async function writeRecord(opened: ReadonlyMap<string, OpenedFile>): Promise<void> {
    await storage.global.set(recordKey, JSON.parse(recordText(opened)) as unknown);
  }

  /** What is in `folder`; nothing if the folder is not there, and the problem noted if unreadable. */
  async function entriesOf(folder: string, problems: string[]): Promise<readonly DirectoryEntry[]> {
    try {
      return await fileSystem.readDirectory(folder);
    } catch (error) {
      if (!FileSystemError.is(error, 'notFound')) {
        problems.push(`${folder}: ${messageOf(error)}`);
      }
      return [];
    }
  }

  /** The `.mp3` files in `folder`, as paths. */
  async function mp3sIn(folder: string, problems: string[]): Promise<string[]> {
    const entries = await entriesOf(folder, problems);
    return entries
      .filter((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.mp3'))
      .map((entry) => join(folder, entry.name));
  }

  /** The sound folders of the fallback storage: one per Course that could not keep its data. */
  async function fallbackSoundFolders(problems: string[]): Promise<string[]> {
    const root = fallbackRoot(storage.folder);
    const entries = await entriesOf(root, problems);
    return entries
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => join(root, entry.name, soundFolderName));
  }

  /**
   * Every sound file that is there, with its size and when it was opened. Files the record has
   * and that are gone are dropped from it; files found by looking and not in it are added.
   */
  async function findSoundFiles(
    use: AudioCacheUse,
    problems: string[],
  ): Promise<{
    readonly files: SoundFile[];
    readonly opened: Map<string, OpenedFile>;
    readonly recordBefore: string;
  }> {
    const opened = readRecord();
    const recordBefore = recordText(opened);
    const paths = new Map<string, string>();
    for (const entry of opened.values()) {
      paths.set(keyOf(entry.path), entry.path);
    }
    for (const folder of [...(await fallbackSoundFolders(problems)), ...use.soundFolders]) {
      for (const path of await mp3sIn(folder, problems)) {
        if (!paths.has(keyOf(path))) {
          paths.set(keyOf(path), path);
        }
      }
    }
    const files: SoundFile[] = [];
    for (const [key, path] of paths) {
      try {
        const { size, modifiedMs } = await fileSystem.stat(path);
        const entry = opened.get(key) ?? { path, openedMs: modifiedMs };
        opened.set(key, entry);
        files.push({ ...entry, size });
      } catch (error) {
        if (FileSystemError.is(error, 'notFound')) {
          opened.delete(key);
        } else {
          problems.push(`${path}: ${messageOf(error)}`);
        }
      }
    }
    return { files, opened, recordBefore };
  }

  /** Deletes `file`: `true` when this call took it away, `false` when it did not. */
  async function deleteFile(file: SoundFile, problems: string[]): Promise<boolean> {
    try {
      await fileSystem.remove(file.path);
      return true;
    } catch (error) {
      // Gone already (another window got there first) is no failure, and nothing this call freed.
      if (!FileSystemError.is(error, 'notFound')) {
        problems.push(`${file.path}: ${messageOf(error)}`);
      }
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

  /** What is in use right now, asked again before each deletion: a Lesson opens while it runs. */
  async function inUseNow(): Promise<AudioCacheUse> {
    return (await source?.()) ?? nothingInUse;
  }

  /**
   * Deletes the files `choose` picks, one after the other. Before each, it asks again what is in
   * use and leaves the file if `keeping` says it is, so a Lesson the learner opens meanwhile keeps
   * the sound it was just handed.
   */
  async function deleteChosen(
    use: AudioCacheUse,
    choose: Choose,
    keeping: (use: AudioCacheUse) => readonly string[],
    problems: string[],
  ): Promise<Deleted> {
    const { files, opened, recordBefore } = await findSoundFiles(use, problems);
    let count = 0;
    let bytes = 0;
    let inUse = 0;
    for (const file of choose(files)) {
      const kept = new Set(keeping(await inUseNow()).map(keyOf));
      if (kept.has(keyOf(file.path))) {
        inUse += 1;
      } else if (await deleteFile(file, problems)) {
        opened.delete(keyOf(file.path));
        count += 1;
        bytes += file.size;
      }
    }
    if (recordText(opened) !== recordBefore) {
      await writeRecord(opened);
    }
    return { count, bytes, inUse };
  }

  async function pruneNow(): Promise<void> {
    const use = await inUseNow();
    const limit = limitBytes(config.get('audioCacheLimit'));
    const keeping = (now: AudioCacheUse): string[] => [...now.loaded, ...now.ahead];
    const kept = new Set(keeping(use).map(keyOf));
    const problems: string[] = [];
    const deleted = await deleteChosen(
      use,
      (files) => {
        let total = files.reduce((sum, file) => sum + file.size, 0);
        const chosen: SoundFile[] = [];
        const oldestFirst = files
          .filter((file) => !kept.has(keyOf(file.path)))
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
      keeping,
      problems,
    );
    if (deleted.count > 0) {
      logger.log({
        level: 'info',
        message: `Deleted ${String(deleted.count)} prepared sound files (${sizeText(deleted.bytes)}) to stay under the audio cache limit.`,
      });
    }
    reportProblems('Could not keep the audio cache under its limit', problems);
  }

  async function clearNow(): Promise<void> {
    const use = await inUseNow();
    const problems: string[] = [];
    const deleted = await deleteChosen(
      use,
      (files) => files,
      (now) => now.loaded,
      problems,
    );
    reportProblems('Could not clear all of the audio cache', problems);
    const stays = deleted.inUse > 0 ? ' The loaded Lesson’s sound stays.' : '';
    if (problems.length > 0) {
      ui.showMessage({
        severity: 'warning',
        text: `FollowAlong deleted ${String(deleted.count)} prepared sound files (${sizeText(deleted.bytes)}), but could not delete the others. See the FollowAlong output.`,
      });
    } else if (deleted.count === 0) {
      ui.showMessage({
        severity: 'info',
        text:
          deleted.inUse > 0
            ? `FollowAlong has no other prepared sound to delete.${stays}`
            : 'The audio cache is empty: there is no prepared sound to delete.',
      });
    } else {
      const files = `${String(deleted.count)} prepared sound file${deleted.count === 1 ? '' : 's'}`;
      ui.showMessage({
        severity: 'info',
        text: `FollowAlong deleted ${files} (${sizeText(deleted.bytes)}).${stays}`,
      });
    }
  }

  /** Changes the record under the cache's turn; `change` says whether it changed anything. */
  function updateRecord(change: (opened: Map<string, OpenedFile>) => boolean): void {
    void exclusive(async () => {
      const opened = readRecord();
      if (change(opened)) {
        await writeRecord(opened);
      }
    }).catch((error: unknown) => {
      logger.log({
        level: 'warn',
        message: `Could not note a prepared sound in the audio cache: ${messageOf(error)}`,
      });
    });
  }

  return {
    made(path) {
      const at = clock.now();
      updateRecord((opened) => {
        if (opened.has(keyOf(path))) {
          return false;
        }
        opened.set(keyOf(path), { path, openedMs: at });
        return true;
      });
    },
    opened(path) {
      const at = clock.now();
      updateRecord((opened) => {
        opened.set(keyOf(path), { path, openedMs: at });
        return true;
      });
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
