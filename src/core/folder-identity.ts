/**
 * Folder identity: when two spellings of a path name one folder. A path is resolved, its drive
 * letter upper-cased and, on Windows, compared without regard to letter case, without asking the
 * file system (ADR 0083). The Courses roots, Recent, hidden Courses, the Course list cache, the
 * Course data and the audio cache all compare folders this way.
 */
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

/** On Windows, two spellings that differ only in letter case name the same folder. */
const caseInsensitive = process.platform === 'win32';

/** The two sets of path rules; a Courses root follows those of the OS VS Code runs on. */
export type PathFlavour = 'win32' | 'posix';

/** The path rules of the OS VS Code runs on. */
export const hostFlavour: PathFlavour = process.platform === 'win32' ? 'win32' : 'posix';

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
 * The identity of the folder `path` names, however it is spelled: resolved, with the drive letter
 * upper-cased, and on Windows without regard to letter case. A path that is not a full path is
 * keyed as written. Recent, hidden Courses and the Course list cache key their folders this way.
 */
export function folderKey(path: string): string {
  return keyOf(normalisedRoot(path) ?? path);
}

/** Whether two paths name one folder, however each is spelled (see {@link folderKey}). */
export function sameFolder(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b);
}

/**
 * Whether `path` lies inside `folder`, at any depth (not `folder` itself), as the paths are spelled:
 * callers that compare across letter case pass both through {@link keyOf} first.
 */
export function isInsideFolder(folder: string, path: string): boolean {
  const inside = relative(folder, path);
  return inside !== '' && !isAbsolute(inside) && inside.split(sep)[0] !== '..';
}
