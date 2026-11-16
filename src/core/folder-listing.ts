/**
 * Reads a Course folder's tree through the File system port, into the listing the Course model
 * reads.
 */
import type { FolderListing } from './course-model.js';
import type { FileSystem } from './ports.js';

export async function readFolderListing(
  fileSystem: FileSystem,
  path: string,
  name: string,
): Promise<FolderListing> {
  const entries = await fileSystem.readDirectory(path);
  return {
    name,
    path,
    files: entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name),
    folders: [],
  };
}
