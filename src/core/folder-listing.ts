/**
 * Reads a Course folder's tree through the File system port, into the listing the Course model
 * reads, and the Course from it.
 */
import { basename, extname, join } from 'node:path';

import {
  buildCourse,
  isLessonFile,
  isSkippedFolder,
  type Course,
  type FolderListing,
} from './course-model.js';
import { courseNames } from './courses-roots.js';
import { FileSystemError, type Ports } from './ports.js';

type ListingPorts = Pick<Ports, 'fileSystem' | 'logger'>;

/**
 * Walks `path` at any depth. A subfolder that cannot be read (for example "System Volume
 * Information" when a drive root is the Course) is logged and left out, and the walk carries on;
 * only `path` itself failing rejects.
 */
export async function readFolderListing(
  ports: ListingPorts,
  path: string,
  name: string,
  readsTitleLists = true,
): Promise<FolderListing> {
  const entries = await ports.fileSystem.readDirectory(path);
  const files = entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name);
  const subfolders = entries.filter(
    (entry) => entry.kind === 'directory' && !isSkippedFolder(entry.name),
  );
  // Only the Course folder and a chain of possible wrapper folders can hold the title list.
  // A folder without Lessons of its own may be a wrapper; the model decides which one is.
  const wrapperBelow = readsTitleLists && !files.some(isLessonFile);
  const folders: FolderListing[] = [];
  for (const entry of subfolders) {
    const subfolder = join(path, entry.name);
    try {
      folders.push(await readFolderListing(ports, subfolder, entry.name, wrapperBelow));
    } catch (error) {
      if (!(error instanceof FileSystemError)) {
        throw error;
      }
      ports.logger.log({
        level: 'warn',
        message: `Skipping ${subfolder}: it cannot be read (${error.message}).`,
      });
    }
  }
  return {
    name,
    path,
    files,
    folders,
    ...(readsTitleLists && { textFiles: await readTextFiles(ports, path, files) }),
  };
}

/** The `.txt` files of a folder, by name. One that cannot be read is logged and left out. */
async function readTextFiles(
  ports: ListingPorts,
  folder: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const texts: Record<string, string> = {};
  for (const file of files.filter((name) => extname(name).toLowerCase() === '.txt')) {
    const path = join(folder, file);
    try {
      texts[file] = await ports.fileSystem.readText(path);
    } catch (error) {
      if (!(error instanceof FileSystemError)) {
        throw error;
      }
      ports.logger.log({
        level: 'warn',
        message: `Ignoring ${path} as a title list: it cannot be read (${error.message}).`,
      });
    }
  }
  return texts;
}

/**
 * Reads the Course in `folder`. Every place that shows a Course's Lesson titles reads it here (the
 * open, the Progress lines, Locate…), so each cleans the file names with the same Course names:
 * the folder's own and its wrappers' up to the Courses root that holds it (ADR 0085). Rejects as
 * {@link readFolderListing} does.
 */
export async function readCourse(
  ports: ListingPorts,
  folder: string,
  roots: readonly string[],
): Promise<Course> {
  return buildCourse(
    await readFolderListing(ports, folder, basename(folder)),
    courseNames(folder, roots),
  );
}
