/**
 * Opening a Course in a new window (spec #12, story 17; ADR 0077; the Course hand-off in GLOSSARY.md). The new window is an empty
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

/** Leaves the Course hand-off asking the next new window to open the Course in `folder`. */
export async function leavePendingCourse(
  store: KeyValueStore,
  folder: string,
  now: number,
): Promise<void> {
  await store.set(noteKey, { folder, at: now });
}

/** Clears the note: used, stale, or taken back by a window that could not be opened. */
export async function withdrawPendingCourse(store: KeyValueStore): Promise<void> {
  await store.set(noteKey, undefined);
}

/** What a window finds when it looks for the note. */
export interface PendingCourseNote {
  /** Whether a note is stored at all, fresh or not: it is cleared by {@link withdrawPendingCourse}. */
  readonly present: boolean;
  /** The folder it names, if it is fresh and well formed. */
  readonly folder: string | undefined;
}

/**
 * Looks at the note without changing it; the window that uses it, or finds it stale, clears it
 * with {@link withdrawPendingCourse}, so it is used at most once. A damaged value is ignored,
 * never repaired. Synchronous, so a window with no note starts its own work at once.
 */
export function readPendingCourse(store: KeyValueStore, now: number): PendingCourseNote {
  const stored = store.get(noteKey);
  const { folder, at } =
    typeof stored === 'object' && stored !== null
      ? (stored as Partial<Record<'folder' | 'at', unknown>>)
      : {};
  const age = typeof at === 'number' ? now - at : Number.NaN;
  const fresh = typeof folder === 'string' && age >= 0 && age <= noteLifetimeMs;
  return {
    present: stored !== undefined,
    folder: fresh ? normalisedRoot(folder) : undefined,
  };
}
