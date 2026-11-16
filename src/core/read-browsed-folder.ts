/**
 * Reads one folder for the Folder browser (ADR 0066) through the File system port: its subfolders
 * and its videos, each in natural order.
 */
import { join } from 'node:path';

import { isLessonFile, naturalOrder } from './course-model.js';
import { isWalked } from './course-scanner.js';
import type { BrowsedFolder, BrowsedVideo } from './folder-browser.js';
import { FileSystemError, type Ports } from './ports.js';

/** What a folder holds, as the browser lists it. */
export interface BrowsedContent {
  readonly folders: readonly BrowsedFolder[];
  readonly videos: readonly BrowsedVideo[];
}

/**
 * The subfolders the scan would walk (not hidden ones, `node_modules`, or the folders Windows
 * keeps at a drive's root) and the videos (`.mp4` and `.webm`) of `folder`. Other files are left
 * out. Rejects with a FileSystemError when `folder` cannot be read.
 */
export async function readBrowsedFolder(
  ports: Pick<Ports, 'fileSystem'>,
  folder: string,
): Promise<BrowsedContent> {
  const entries = await ports.fileSystem.readDirectory(folder);
  const byName = (a: { name: string }, b: { name: string }): number => naturalOrder(a.name, b.name);
  return {
    folders: entries
      .filter((entry) => entry.kind === 'directory' && isWalked(entry.name))
      .map((entry) => ({ name: entry.name, path: join(folder, entry.name) }))
      .sort(byName),
    videos: entries
      .filter((entry) => entry.kind === 'file' && isLessonFile(entry.name))
      .map((entry) => ({ name: entry.name, path: join(folder, entry.name) }))
      .sort(byName),
  };
}

/**
 * `folders` with whether each directly holds a video. A folder that cannot be read counts as one
 * that holds none: the learner is told when they open it.
 */
export async function lookForVideos(
  ports: Pick<Ports, 'fileSystem'>,
  folders: readonly BrowsedFolder[],
): Promise<BrowsedFolder[]> {
  return Promise.all(
    folders.map(async (folder) => {
      try {
        const entries = await ports.fileSystem.readDirectory(folder.path);
        return {
          ...folder,
          holdsVideos: entries.some((entry) => entry.kind === 'file' && isLessonFile(entry.name)),
        };
      } catch (error) {
        if (!(error instanceof FileSystemError)) {
          throw error;
        }
        return { ...folder, holdsVideos: false };
      }
    }),
  );
}
