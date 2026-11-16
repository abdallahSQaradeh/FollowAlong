/**
 * The Course scanner (spec #12, Core modules → Course scanner): finds the Courses under the
 * Courses roots through the File system port. It decides nothing about how a Course is shown; the
 * Course picker does that.
 */
import { dirname, join, posix, relative, sep, win32 } from 'node:path';

import { isLessonFile, isSkippedFolder, naturalOrder } from './course-model.js';
import { hostFlavour, type PathFlavour } from './courses-roots.js';
import { type DirectoryEntry, FileSystemError, type Ports } from './ports.js';

type ScanPorts = Pick<Ports, 'fileSystem' | 'logger'>;

/** A Course the scan found. */
export interface ScannedCourse {
  /** The Course's name: its outermost single-child wrapper folder's name (ADR 0032). */
  readonly name: string;
  /** Absolute path of the Course folder, spelled from its Courses root as the setting has it. */
  readonly folder: string;
  /**
   * The category folders between the Courses root and the folder the Course is named after,
   * outermost first (`['Web', 'Frontend']`); empty for a Course directly under its root.
   */
  readonly categories: readonly string[];
}

/** What the scan of the Courses roots found. */
export interface CourseScan {
  /** Every Course found, A–Z by name in natural order, each folder once. */
  readonly courses: readonly ScannedCourse[];
  /** The Courses roots that could not be read (missing, or not allowed), as the setting has them. */
  readonly unreadableRoots: readonly string[];
}

/** A Course the walk found, before it is named: where its Lessons are, and what names it. */
interface FoundCourse {
  readonly folder: string;
  /** The Course folder, or the outermost single-child wrapper folder around it. */
  readonly nameFolder: string;
}

/**
 * Walks each Courses root at any depth, with no depth limit. The first folder on a branch that
 * directly holds a Lesson file is a Course, and the walk does not go below it: its subfolders are
 * its Sections. So is a known Course, a folder holding `.followalong`, when a Lesson is anywhere
 * below it. A folder that holds only a zip has no Lesson and is not a Course. A Course is named
 * after the outermost single-child wrapper around it, never after its Courses root, and filed
 * under the folders between the root and that name. Hidden folders (a leading `.`, so `.git` and
 * `.followalong` too), `node_modules`, `$RECYCLE.BIN` and `System Volume Information` are not
 * walked. A subfolder that cannot be read is logged and left out, and the walk carries on. A
 * Course under two roots is listed once, as the root named first files it.
 */
export async function scanCourses(ports: ScanPorts, roots: readonly string[]): Promise<CourseScan> {
  const found = new Map<string, ScannedCourse>();
  const unreadableRoots: string[] = [];
  for (const root of roots) {
    try {
      for (const course of await walk(ports, root, true)) {
        if (!found.has(course.folder)) {
          found.set(course.folder, scannedCourse(root, course));
        }
      }
    } catch (error) {
      if (!(error instanceof FileSystemError)) {
        throw error;
      }
      ports.logger.log({
        level: 'warn',
        message: `Cannot read the Courses root ${root} (${error.message}).`,
      });
      unreadableRoots.push(root);
    }
  }
  const courses = [...found.values()].sort(
    (a, b) => naturalOrder(a.name, b.name) || naturalOrder(a.folder, b.folder),
  );
  return { courses, unreadableRoots };
}

function scannedCourse(root: string, { folder, nameFolder }: FoundCourse): ScannedCourse {
  const categories =
    nameFolder === root
      ? []
      : relative(root, dirname(nameFolder))
          .split(sep)
          .filter((segment) => segment !== '');
  return { name: folderLabel(nameFolder), folder, categories };
}

/**
 * What a folder is called: its name, or for the root of a drive (`D:\`, whose name is empty) the
 * drive (`D:`), or `/`. `flavour` is the host's; tests give each one on every OS.
 */
export function folderLabel(folder: string, flavour: PathFlavour = hostFlavour): string {
  const rules = flavour === 'win32' ? win32 : posix;
  const name = rules.basename(folder);
  if (name !== '') {
    return name;
  }
  const { root } = rules.parse(folder);
  return root.length > 1 ? root.replace(/[\\/]+$/, '') : root;
}

/**
 * Folders Windows keeps at the root of a drive, which a drive named as a Courses root would show:
 * the recycle bin holds deleted Courses, which must not be offered. Matched in any letter case.
 */
const driveFolders = new Set(['$recycle.bin', 'system volume information']);

/** Whether the scan walks into a subfolder of this name. */
function isWalked(name: string): boolean {
  return !isSkippedFolder(name) && !driveFolders.has(name.toLowerCase());
}

/** FollowAlong's own folder: a Course that holds it is a known Course. */
const courseDataFolder = '.followalong';

/** Whether the directory entry is a file that is a Lesson. */
function isLesson(entry: DirectoryEntry): boolean {
  return entry.kind === 'file' && isLessonFile(entry.name);
}

/**
 * The Courses at or below `folder`. A folder that holds no Course itself and has exactly one
 * Course below it is a wrapper around it, unless it is the Courses root, and takes over its name.
 * Rejects only when `folder` itself cannot be read.
 */
async function walk(
  ports: ScanPorts,
  folder: string,
  isRoot: boolean,
): Promise<readonly FoundCourse[]> {
  const entries = await ports.fileSystem.readDirectory(folder);
  if (entries.some(isLesson)) {
    return [{ folder, nameFolder: folder }];
  }
  if (entries.some((entry) => entry.kind === 'directory' && entry.name === courseDataFolder)) {
    // A known Course. Whether or not it holds a Lesson, nothing below it is another Course.
    return (await holdsLessonBelow(ports, folder, entries)) ? [{ folder, nameFolder: folder }] : [];
  }
  const courses: FoundCourse[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'directory' || !isWalked(entry.name)) {
      continue;
    }
    const subfolder = join(folder, entry.name);
    try {
      courses.push(...(await walk(ports, subfolder, false)));
    } catch (error) {
      skipUnreadable(ports, subfolder, error);
    }
  }
  const [only, ...others] = courses;
  return !isRoot && only !== undefined && others.length === 0
    ? [{ folder: only.folder, nameFolder: folder }]
    : courses;
}

/** Whether a Lesson is anywhere below `folder`, whose listing is `entries`. */
async function holdsLessonBelow(
  ports: ScanPorts,
  folder: string,
  entries: readonly DirectoryEntry[],
): Promise<boolean> {
  for (const entry of entries) {
    if (entry.kind !== 'directory' || !isWalked(entry.name)) {
      continue;
    }
    const subfolder = join(folder, entry.name);
    try {
      const inside = await ports.fileSystem.readDirectory(subfolder);
      if (inside.some(isLesson) || (await holdsLessonBelow(ports, subfolder, inside))) {
        return true;
      }
    } catch (error) {
      skipUnreadable(ports, subfolder, error);
    }
  }
  return false;
}

/** Logs a subfolder the scan leaves out because it cannot be read; any other failure is a bug. */
function skipUnreadable(ports: ScanPorts, subfolder: string, error: unknown): void {
  if (!(error instanceof FileSystemError)) {
    throw error;
  }
  ports.logger.log({
    level: 'warn',
    message: `Skipping ${subfolder} in the Course scan: it cannot be read (${error.message}).`,
  });
}
