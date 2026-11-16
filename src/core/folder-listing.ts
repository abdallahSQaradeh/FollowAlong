/**
 * Reads a Course folder's tree through the File system port, into the listing the Course model
 * reads.
 */
import { join } from 'node:path';

import { isSkippedFolder, type FolderListing } from './course-model.js';
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
): Promise<FolderListing> {
  const entries = await ports.fileSystem.readDirectory(path);
  const folders: FolderListing[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'directory' || isSkippedFolder(entry.name)) {
      continue;
    }
    const subfolder = join(path, entry.name);
    try {
      folders.push(await readFolderListing(ports, subfolder, entry.name));
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
    files: entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name),
    folders,
  };
}
