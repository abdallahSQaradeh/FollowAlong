/**
 * Recent Courses (spec #12, stories 3, 9, 19; ADR 0041): the Courses the learner opened last, kept
 * on this machine in the global storage as a list of absolute folders, newest first. A Recent
 * Course is a known Course for the scan (ADR 0032). The list is read and changed whole, through
 * the Storage port, so nothing here depends on VS Code.
 */
import type { RecentCourse } from './course-picker.js';
import { folderLabel, type ScannedCourse } from './course-scanner.js';
import { keyOf, normalisedRoot } from './courses-roots.js';
import { FileSystemError, type KeyValueStore, type Ports } from './ports.js';

/** Global storage key of the list. */
const recentKey = 'recentCourses';

/** How many Courses Recent keeps and the Course picker shows. */
export const recentLimit = 5;

/** Each folder once, in the order given: the first of two spellings of one folder stays. */
function onceEach(folders: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const folder of folders) {
    if (!seen.has(keyOf(folder))) {
      seen.set(keyOf(folder), folder);
    }
  }
  return [...seen.values()];
}

/** The Recent Courses' folders, newest first. Anything stored that is not a full path is ignored. */
export function readRecent(store: KeyValueStore): readonly string[] {
  const stored = store.get(recentKey);
  const entries = Array.isArray(stored) ? (stored as unknown[]) : [];
  const folders = entries.flatMap((entry) =>
    typeof entry === 'string' ? (normalisedRoot(entry) ?? []) : [],
  );
  return onceEach(folders).slice(0, recentLimit);
}

/** Puts `folder` first, once, and drops what no longer fits. */
export async function recordOpened(store: KeyValueStore, folder: string): Promise<void> {
  const opened = normalisedRoot(folder);
  if (opened === undefined) {
    return;
  }
  await store.set(recentKey, onceEach([opened, ...readRecent(store)]).slice(0, recentLimit));
}

/** Drops `folder` from Recent. */
export async function removeRecent(store: KeyValueStore, folder: string): Promise<void> {
  const removed = normalisedRoot(folder);
  await store.set(
    recentKey,
    readRecent(store).filter((other) => removed === undefined || keyOf(other) !== keyOf(removed)),
  );
}

/**
 * Points the Recent Course at `from` to `to` instead, keeping its place. If `to` is in Recent
 * already, the entry that is nearer the top stays and the other goes.
 */
export async function relocateRecent(
  store: KeyValueStore,
  from: string,
  to: string,
): Promise<void> {
  const source = normalisedRoot(from);
  const target = normalisedRoot(to);
  if (target === undefined) {
    return;
  }
  const moved = readRecent(store).map((folder) =>
    source !== undefined && keyOf(folder) === keyOf(source) ? target : folder,
  );
  await store.set(recentKey, onceEach(moved));
}

/** Whether the folder is gone: the folder is not there, or its drive is not. */
async function isMissing(ports: Pick<Ports, 'fileSystem'>, folder: string): Promise<boolean> {
  try {
    await ports.fileSystem.readDirectory(folder);
    return false;
  } catch (error) {
    if (error instanceof FileSystemError) {
      // Any other failure (not allowed, not a folder) is for opening the Course to explain.
      return error.reason === 'notFound';
    }
    throw error;
  }
}

/** The Recent Courses as the Course picker shows them: named and filed as the scan has them. */
export async function recentCourses(
  ports: Pick<Ports, 'fileSystem'>,
  folders: readonly string[],
  scanned: readonly ScannedCourse[],
): Promise<RecentCourse[]> {
  const byFolder = new Map(scanned.map((course) => [keyOf(course.folder), course]));
  return Promise.all(
    folders.map(async (folder): Promise<RecentCourse> => {
      const found = byFolder.get(keyOf(folder));
      return {
        folder,
        name: found?.name ?? folderLabel(folder),
        categories: found?.categories ?? [],
        // A Course the scan found is there; any other is looked for.
        missing: found === undefined && (await isMissing(ports, folder)),
      };
    }),
  );
}
