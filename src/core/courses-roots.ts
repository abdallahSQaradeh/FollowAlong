/**
 * The Courses roots (ADR 0022): the `followalong.coursesRoots` setting, read and written through
 * the Config port, and the folders the player may read media from, which follow from it.
 */
import { basename, isAbsolute, posix, relative, resolve, sep } from 'node:path';

import type { Config } from './ports.js';

/** The learner's Courses roots: a user-level list of folders, empty by default (spec #12). */
const coursesRootsSetting = 'coursesRoots';

/** On Windows, two spellings that differ only in letter case name the same folder. */
const caseInsensitive = process.platform === 'win32';

/** The two sets of path rules; a Courses root follows those of the OS VS Code runs on. */
export type PathFlavour = 'win32' | 'posix';

/** The path rules of the OS VS Code runs on. */
export const hostFlavour: PathFlavour = process.platform === 'win32' ? 'win32' : 'posix';

/** What the setting holds, as the core uses it. */
export interface CoursesRoots {
  /** The roots, each spelled one way and listed once, in the order the setting has them. */
  readonly roots: readonly string[];
  /** Entries that are not a full path (`.`, `~`, `Courses`), as written: they are skipped. */
  readonly notAbsolute: readonly string[];
}

/**
 * The one spelling of a root: resolved (no `.` or `..` segments, no trailing separator) and, on
 * Windows, with an upper-case drive letter. `undefined` for a path that is not a full path, which
 * could otherwise resolve against whatever folder or drive VS Code runs in.
 */
export function normalisedRoot(path: string): string | undefined {
  if (!isFullPath(path)) {
    return undefined;
  }
  return resolve(path).replace(/^([a-z]):/, (drive) => drive.toUpperCase());
}

/**
 * Whether `path` names one folder wherever VS Code runs. On Windows that takes a drive (`D:\`) or
 * a share (`\\server\share`): `\Learning` counts as absolute there, but on whichever drive
 * VS Code happens to run from. The verbatim (`\\?\D:\Learning`) and device (`\\.\…`) prefixes
 * are not full paths: they name a folder another way, which would count as a second root and
 * skip the drive-letter normalisation (ADR 0033). `flavour` is the host's; tests give each one
 * on every OS.
 */
export function isFullPath(path: string, flavour: PathFlavour = hostFlavour): boolean {
  return flavour === 'win32'
    ? /^([a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path) && !/^[\\/]{2}[?.][\\/]/.test(path)
    : posix.isAbsolute(path);
}

/** What two spellings of one folder share, for comparing roots. */
export function keyOf(normalised: string): string {
  return caseInsensitive ? normalised.toLowerCase() : normalised;
}

/**
 * Whether two paths name one folder, however each is spelled: resolved, with the drive letter
 * upper-cased, and on Windows without regard to letter case.
 */
export function sameFolder(a: string, b: string): boolean {
  return keyOf(normalisedRoot(a) ?? a) === keyOf(normalisedRoot(b) ?? b);
}

/**
 * Whether `path` lies inside `folder`, at any depth (not `folder` itself), as the paths are spelled:
 * callers that compare across letter case pass both through {@link keyOf} first.
 */
export function isInsideFolder(folder: string, path: string): boolean {
  const inside = relative(folder, path);
  return inside !== '' && !isAbsolute(inside) && inside.split(sep)[0] !== '..';
}

/**
 * The names a Lesson file name may end in as ` _ <name>`: the Course folder's own, then the name of
 * each folder between it and the first Courses root that is it or holds it, inside out, as the scan
 * files the Course (ADR 0022). A Course's outermost wrapper, whose name the Course picker shows
 * (ADR 0032), is always among them. A Course under no root, or whose first such root is the Course
 * folder itself, has only its own name; with an outer root named first, the wrappers' names count.
 * The root's own name is never one (ADR 0085).
 */
export function courseNames(folder: string, roots: readonly string[]): string[] {
  const own = basename(folder);
  const spelled = normalisedRoot(folder) ?? folder;
  // The first root that is the folder or holds it, as the scan files the Course (ADR 0022).
  const root = roots.find(
    (candidate) =>
      keyOf(candidate) === keyOf(spelled) || isInsideFolder(keyOf(candidate), keyOf(spelled)),
  );
  if (root === undefined || keyOf(root) === keyOf(spelled)) {
    return [own];
  }
  // How many folders lie between, counted on the keys; their names taken as the folder spells them.
  const depth = relative(keyOf(root), keyOf(spelled)).split(sep).length;
  const between = spelled.split(sep).slice(-depth).reverse();
  return [own, ...between.slice(1)];
}

/** The setting's entries that are text, as written. */
function entriesOf(config: Pick<Config, 'get'>): unknown[] {
  const value = config.get(coursesRootsSetting);
  return Array.isArray(value) ? value : [];
}

/** The Courses roots the learner named, normalised, each once; other entries are ignored. */
export function readCoursesRoots(config: Pick<Config, 'get'>): CoursesRoots {
  const roots = new Map<string, string>();
  const notAbsolute: string[] = [];
  for (const entry of entriesOf(config)) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      continue;
    }
    const root = normalisedRoot(entry);
    if (root === undefined) {
      notAbsolute.push(entry);
    } else if (!roots.has(keyOf(root))) {
      roots.set(keyOf(root), root);
    }
  }
  return { roots: [...roots.values()], notAbsolute };
}

/**
 * Adds `root` (an absolute path) after the entries already in the setting, which stay as the
 * learner wrote them. Resolves with whether the setting changed: a root already there, in any
 * spelling, is not added again.
 */
export async function addCoursesRoot(config: Config, root: string): Promise<boolean> {
  const added = normalisedRoot(root);
  if (added === undefined) {
    throw new Error(`addCoursesRoot: ${root} is not an absolute path.`);
  }
  if (readCoursesRoots(config).roots.some((known) => keyOf(known) === keyOf(added))) {
    return false;
  }
  await config.update(coursesRootsSetting, [...entriesOf(config), added]);
  return true;
}

/**
 * The folders the player may read media from: the Courses roots, the Course folder when it is
 * outside them, and the fallback root of Course data (`<storage>/courses`, ADR 0025), not the
 * whole extension storage. A change reloads the player page, which loses the click that lets it
 * start playback (#12 D3), so Courses under the same roots share them.
 */
export function playerFolders(
  roots: readonly string[],
  courseFolder: string,
  courseDataFallbackRoot: string,
): string[] {
  const underARoot = roots.some((root) => isSpelledInside(courseFolder, root));
  return [...roots, ...(underARoot ? [] : [courseFolder]), courseDataFallbackRoot];
}

/**
 * Whether `path` is `folder` or inside it, spelled the same way, letter case included. VS Code
 * matches a file against the player's folders by spelling, so a Course whose path differs in case
 * from its root's is given to the player as its own folder rather than left unreadable.
 */
function isSpelledInside(path: string, folder: string): boolean {
  const withSeparator = folder.endsWith(sep) ? folder : `${folder}${sep}`;
  return path === folder || path.startsWith(withSeparator);
}
