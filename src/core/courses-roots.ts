/**
 * The Courses roots (ADR 0022): the `followalong.coursesRoots` setting, read and written through
 * the Config port, and the folders the player may read media from, which follow from it.
 */
import { isAbsolute, relative, sep } from 'node:path';

import type { Config } from './ports.js';

/** The learner's Courses roots: a user-level list of folders, empty by default (spec #12). */
const coursesRootsSetting = 'coursesRoots';

/** The Courses roots the learner named, as written in the setting; anything else is ignored. */
export function readCoursesRoots(config: Pick<Config, 'get'>): string[] {
  const value = config.get(coursesRootsSetting);
  return Array.isArray(value)
    ? value.filter((root): root is string => typeof root === 'string' && root !== '')
    : [];
}

/**
 * Adds `root` after the Courses roots already set. Resolves with whether the setting changed:
 * a root already there is not added twice.
 */
export async function addCoursesRoot(config: Config, root: string): Promise<boolean> {
  const roots = readCoursesRoots(config);
  if (roots.includes(root)) {
    return false;
  }
  await config.update(coursesRootsSetting, [...roots, root]);
  return true;
}

/**
 * The folders the player may read media from: the Courses roots, the Course folder when it is
 * outside them, and the extension storage. A change reloads the player page, which loses the
 * click that lets it start playback (#12 D3), so Courses under the same roots share them.
 */
export function playerFolders(
  roots: readonly string[],
  courseFolder: string,
  storageFolder: string,
): string[] {
  const underARoot = roots.some((root) => isInside(courseFolder, root));
  return [...roots, ...(underARoot ? [] : [courseFolder]), storageFolder];
}

/** Whether `path` is `folder` or inside it. */
function isInside(path: string, folder: string): boolean {
  const fromFolder = relative(folder, path);
  const above = fromFolder === '..' || fromFolder.startsWith(`..${sep}`);
  return !above && !isAbsolute(fromFolder);
}
