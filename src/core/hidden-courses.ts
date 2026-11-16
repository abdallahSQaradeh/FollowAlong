/**
 * The hidden-Course list (spec #12, story 10; ADR 0072): the folders the learner hid from the
 * Course picker because they are not Courses (a `code\…\images` folder holding one video). Kept on
 * this machine in the global storage, like Recent (ADR 0041), as a list of `{ folder, name }`:
 * the absolute folder, and the name the picker listed it under, so Unhide can name it without a
 * scan. It never touches a Course folder (story 106), and a rescan does not change it: the picker
 * filters what it lists by it.
 */
import { folderLabel } from './course-scanner.js';
import { keyOf, normalisedRoot } from './courses-roots.js';
import type { KeyValueStore, Ports } from './ports.js';

/** Global storage key of the list. */
const hiddenKey = 'hiddenCourses';

/** A Course the learner hid. */
export interface HiddenCourse {
  /** The Course folder, normalised: its identity, as in Recent and the Course list cache. */
  readonly folder: string;
  /** The name the Course picker listed it under. */
  readonly name: string;
}

/** The identity of a hidden Course: its folder, normalised the way the cache and Recent do. */
export function hiddenKeyOf(folder: string): string {
  return keyOf(normalisedRoot(folder) ?? folder);
}

/**
 * The hidden Courses, each once, oldest first. A stored entry that has no full-path folder is
 * ignored; one with no name is named by its folder.
 */
export function readHidden(store: KeyValueStore): readonly HiddenCourse[] {
  const stored = store.get(hiddenKey);
  const entries = Array.isArray(stored) ? (stored as unknown[]) : [];
  const seen = new Map<string, HiddenCourse>();
  for (const entry of entries) {
    const { folder, name } =
      typeof entry === 'object' && entry !== null
        ? (entry as Partial<Record<keyof HiddenCourse, unknown>>)
        : {};
    const normalised = typeof folder === 'string' ? normalisedRoot(folder) : undefined;
    if (normalised !== undefined && !seen.has(keyOf(normalised))) {
      seen.set(keyOf(normalised), {
        folder: normalised,
        name: typeof name === 'string' && name !== '' ? name : folderLabel(normalised),
      });
    }
  }
  return [...seen.values()];
}

/** Adds the Course to the hidden-Course list; a folder already there stays once. */
export async function hideCourse(store: KeyValueStore, course: HiddenCourse): Promise<void> {
  const folder = normalisedRoot(course.folder);
  const current = readHidden(store);
  if (folder === undefined || current.some((other) => keyOf(other.folder) === keyOf(folder))) {
    return;
  }
  await store.set(hiddenKey, [...current, { folder, name: course.name }]);
}

/**
 * `FollowAlong: Unhide a Course…`: lists the hidden Courses, and takes the one the learner picks
 * off the list, so the Course picker offers it again. Only that one: the others stay hidden.
 */
export async function unhideCourse(ports: Pick<Ports, 'storage' | 'ui'>): Promise<void> {
  const store = ports.storage.global;
  const hidden = readHidden(store);
  if (hidden.length === 0) {
    ports.ui.showMessage({ severity: 'info', text: 'No Courses are hidden.' });
    return;
  }
  const picked = await ports.ui.pick<HiddenCourse>({
    title: 'Unhide a Course',
    placeholder: 'Pick a hidden Course to show it in the Course picker again',
    matchOnDescription: true,
    entries: hidden.map((course) => ({
      kind: 'item',
      label: course.name,
      description: course.folder,
      intent: course,
    })),
  });
  if (picked === undefined) {
    return;
  }
  await store.set(
    hiddenKey,
    readHidden(store).filter((course) => keyOf(course.folder) !== keyOf(picked.folder)),
  );
  ports.ui.showMessage({ severity: 'info', text: `“${picked.name}” is no longer hidden.` });
}
