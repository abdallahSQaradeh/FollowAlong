/**
 * Recent Courses (spec #12, stories 3, 9, 19; ADR 0041): the Courses the learner opened last, kept
 * on this machine in the global storage as a list of absolute folders, newest first. A Recent
 * Course is a known Course for the scan (ADR 0032). The list is read and changed whole, through
 * the Storage port, so nothing here depends on VS Code.
 */
import { keyOf, normalisedRoot } from './courses-roots.js';
import type { KeyValueStore } from './ports.js';

/** Global storage key of the list. */
const recentKey = 'recentCourses';

/** How many Courses Recent keeps and the Course picker shows. */
export const recentLimit = 5;

/** The folder as Recent spells it: the one spelling of ADR 0022. `undefined` if not a full path. */
function spelled(folder: string): string | undefined {
  return normalisedRoot(folder);
}

/** The Recent Courses' folders, newest first. Anything stored that is not a full path is ignored. */
export function readRecent(store: KeyValueStore): readonly string[] {
  const stored = store.get(recentKey);
  const folders = new Map<string, string>();
  for (const entry of Array.isArray(stored) ? (stored as unknown[]) : []) {
    const folder = typeof entry === 'string' ? spelled(entry) : undefined;
    if (folder !== undefined && !folders.has(keyOf(folder))) {
      folders.set(keyOf(folder), folder);
    }
  }
  return [...folders.values()].slice(0, recentLimit);
}

/** Puts `folder` first, once, and drops what no longer fits. */
export async function recordOpened(store: KeyValueStore, folder: string): Promise<void> {
  const opened = spelled(folder);
  if (opened === undefined) {
    return;
  }
  const others = readRecent(store).filter((other) => keyOf(other) !== keyOf(opened));
  await store.set(recentKey, [opened, ...others].slice(0, recentLimit));
}

/** Drops `folder` from Recent. */
export async function removeRecent(store: KeyValueStore, folder: string): Promise<void> {
  const removed = spelled(folder);
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
  const source = spelled(from);
  const target = spelled(to);
  if (target === undefined) {
    return;
  }
  const folders = new Map<string, string>();
  for (const folder of readRecent(store)) {
    const moved = source !== undefined && keyOf(folder) === keyOf(source) ? target : folder;
    if (!folders.has(keyOf(moved))) {
      folders.set(keyOf(moved), moved);
    }
  }
  await store.set(recentKey, [...folders.values()]);
}
