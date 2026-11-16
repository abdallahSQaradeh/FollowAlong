/**
 * The Course scanner (spec #12, Core modules → Course scanner): finds the Courses under the
 * Courses roots through the File system port. It decides nothing about how a Course is shown; the
 * Course picker does that.
 */
import { join, posix, win32 } from 'node:path';

import { isLessonFile, isSkippedFolder, naturalOrder } from './course-model.js';
import { hostFlavour, type PathFlavour } from './courses-roots.js';
import { FileSystemError, type Ports } from './ports.js';

type ScanPorts = Pick<Ports, 'fileSystem' | 'logger'>;

/** A Course the scan found. */
export interface ScannedCourse {
  /** The Course's name: its folder's name. */
  readonly name: string;
  /** Absolute path of the Course folder, spelled from its Courses root as the setting has it. */
  readonly folder: string;
}

/** What the scan of the Courses roots found. */
export interface CourseScan {
  /** Every Course found, A–Z by name in natural order, each folder once. */
  readonly courses: readonly ScannedCourse[];
  /** The Courses roots that could not be read (missing, or not allowed), as the setting has them. */
  readonly unreadableRoots: readonly string[];
}

/**
 * Walks each Courses root at any depth. The first folder on a branch that directly holds a Lesson
 * file is a Course, and the walk does not go below it: its subfolders are its Sections. Hidden
 * folders (a leading `.`, so `.git` and `.followalong` too), `node_modules`, `$RECYCLE.BIN` and
 * `System Volume Information` are not walked.
 * A subfolder that cannot be read is logged and left out, and the walk carries on.
 */
export async function scanCourses(ports: ScanPorts, roots: readonly string[]): Promise<CourseScan> {
  const found = new Map<string, ScannedCourse>();
  const unreadableRoots: string[] = [];
  for (const root of roots) {
    try {
      await walk(ports, root, found);
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

/** Rejects only when `folder` itself cannot be read. */
async function walk(
  ports: ScanPorts,
  folder: string,
  found: Map<string, ScannedCourse>,
): Promise<void> {
  const entries = await ports.fileSystem.readDirectory(folder);
  if (entries.some((entry) => entry.kind === 'file' && isLessonFile(entry.name))) {
    found.set(folder, { name: folderLabel(folder), folder });
    return;
  }
  for (const entry of entries) {
    if (entry.kind !== 'directory' || !isWalked(entry.name)) {
      continue;
    }
    const subfolder = join(folder, entry.name);
    try {
      await walk(ports, subfolder, found);
    } catch (error) {
      if (!(error instanceof FileSystemError)) {
        throw error;
      }
      ports.logger.log({
        level: 'warn',
        message: `Skipping ${subfolder} in the Course scan: it cannot be read (${error.message}).`,
      });
    }
  }
}
