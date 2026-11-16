/**
 * Opening a Course in a new window (spec #12, story 17; ADR 0077). The new window is an empty
 * window, so the workspace folder is untouched (story 20) and it cannot be told which Course to
 * open by its folder. The window that asks leaves a short-lived note in the global storage: the
 * Course folder and when it was written. The new window's activation takes the note once. A note
 * not taken within {@link noteLifetimeMs} is ignored, so a stray note never opens a Course later.
 */
import { normalisedRoot } from './courses-roots.js';
import type { KeyValueStore } from './ports.js';

/** Global storage key of the note. */
const noteKey = 'pendingCourse';

/** How long a window has to take the note: a new window starts in a few seconds. */
export const noteLifetimeMs = 30_000;

/** Leaves a note asking the next new window to open the Course in `folder`. */
export async function leavePendingCourse(
  store: KeyValueStore,
  folder: string,
  now: number,
): Promise<void> {
  await store.set(noteKey, { folder, at: now });
}

/** Takes the note back without using it, for a new window that could not be opened. */
export async function withdrawPendingCourse(store: KeyValueStore): Promise<void> {
  await store.set(noteKey, undefined);
}

/**
 * Takes the note: the folder it names if it is fresh and well formed, else `undefined`. The note
 * is gone either way, so it is used at most once. A damaged value is ignored, never repaired.
 */
export async function takePendingCourse(
  store: KeyValueStore,
  now: number,
): Promise<string | undefined> {
  const stored = store.get(noteKey);
  if (stored === undefined) {
    return undefined;
  }
  await store.set(noteKey, undefined);
  const { folder, at } =
    typeof stored === 'object' && stored !== null
      ? (stored as Partial<Record<'folder' | 'at', unknown>>)
      : {};
  if (typeof folder !== 'string' || typeof at !== 'number') {
    return undefined;
  }
  const age = now - at;
  return age >= 0 && age <= noteLifetimeMs ? normalisedRoot(folder) : undefined;
}
