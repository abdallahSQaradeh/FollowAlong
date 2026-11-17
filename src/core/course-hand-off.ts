/**
 * The Course hand-off (spec #12, story 17; ADR 0077; GLOSSARY.md): how _Open in new window_ tells
 * the new window which Course to open. The new window is an empty window, so the workspace folder
 * is untouched (story 20) and it cannot be told which Course to open by its folder. The window that
 * asks leaves a short-lived note in the global storage: the Course folder and when it was written.
 * The new window's activation takes the note once. A note not taken within {@link noteLifetimeMs}
 * is ignored, so a stray note never opens a Course later.
 */
import { basename } from 'node:path';

import { normalisedRoot } from './folder-identity.js';
import { messageOf } from './logger.js';
import type { KeyValueStore, Ports } from './ports.js';

type HandOffPorts = Pick<Ports, 'storage' | 'clock' | 'ui' | 'logger'>;

/** Global storage key of the note (named before the glossary had “Course hand-off”). */
const noteKey = 'pendingCourse';

/** How long a window has to take the note: a new window starts in a few seconds. */
const noteLifetimeMs = 30_000;

/** Clears the note: used, stale, or taken back by a window that could not be opened. */
async function withdrawNote(store: KeyValueStore): Promise<void> {
  await store.set(noteKey, undefined);
}

/** What a window finds when it looks for the note. */
interface Note {
  /** Whether a note is stored at all, fresh or not: it is cleared by {@link withdrawNote}. */
  readonly present: boolean;
  /** The folder it names, if it is fresh and well formed. */
  readonly folder: string | undefined;
}

/**
 * Looks at the note without changing it. A damaged value is ignored, never repaired.
 * Synchronous, so a window with no note starts its own work at once.
 */
function readNote(store: KeyValueStore, now: number): Note {
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

/**
 * _Open in new window_: leaves the note for the new window, then opens it; this window's Course is
 * not touched. When the window cannot be opened, the learner is told and the note is taken back.
 */
export async function handOffCourse(ports: HandOffPorts, folder: string): Promise<void> {
  const { storage, clock, ui, logger } = ports;
  try {
    await storage.global.set(noteKey, { folder, at: clock.now() });
    await ui.openNewWindow();
  } catch (error) {
    logger.log({
      level: 'error',
      message: `Could not open “${folder}” in a new window: ${messageOf(error)}`,
    });
    ui.showMessage({
      severity: 'error',
      text: `FollowAlong could not open “${basename(folder)}” in a new window.`,
    });
    await withdrawNote(storage.global).catch(() => {
      // Nothing more to do: the note expires by itself after 30 seconds.
    });
  }
}

/**
 * Takes the note once, when this window may be the new one: only a window with no workspace may
 * (ADR 0077), whatever it remembers. A note found, fresh or stale, is cleared first, so it is used
 * at most once; a failure to clear it is logged and does not stop the open. The promise resolves
 * with the folder of a fresh note, else `undefined`.
 *
 * With no note to take it returns `undefined` at once, not a promise: the window then queues the
 * Course it remembers in the same turn, so an open the learner asks for meanwhile comes after it
 * and wins (ADR 0022).
 */
export function takeCourseHandOff(ports: HandOffPorts): Promise<string | undefined> | undefined {
  const { storage, clock, logger } = ports;
  if (!storage.workspaceIsEmpty) {
    return undefined;
  }
  const note = readNote(storage.global, clock.now());
  if (!note.present) {
    return undefined;
  }
  return withdrawNote(storage.global).then(
    () => note.folder,
    (error: unknown) => {
      logger.log({
        level: 'warn',
        message: `Could not clear the Course hand-off: ${messageOf(error)}`,
      });
      return note.folder;
    },
  );
}
