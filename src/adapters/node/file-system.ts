/**
 * The File system port over Node's `fs`. Used by the extension and, as the real file system, by
 * Seam 1 tests. Failures become a FileSystemError whose `reason` is the read-only check.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  FileSystemError,
  type DirectoryEntry,
  type FileSystem,
  type FileSystemErrorReason,
} from '../../core/ports.js';

const run = promisify(execFile);

function reasonOf(error: unknown): FileSystemErrorReason {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'notFound';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'readOnly';
    default:
      return 'other';
  }
}

async function wrap<T>(path: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof FileSystemError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new FileSystemError(reasonOf(error), path, message);
  }
}

let temporaryCounter = 0;

export function createNodeFileSystem(): FileSystem {
  return {
    readDirectory: (path) =>
      wrap(path, async () => {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((entry): DirectoryEntry => ({
          name: entry.name,
          kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
        }));
      }),

    readText: (path) => wrap(path, () => readFile(path, 'utf8')),

    writeText: (path, content) =>
      wrap(path, async () => {
        // Write beside the target, then rename over it, so a reader never sees half a file.
        temporaryCounter += 1;
        const temporary = join(
          dirname(path),
          `.${basename(path)}.${String(process.pid)}-${String(temporaryCounter)}.tmp`,
        );
        try {
          await writeFile(temporary, content, 'utf8');
          await rename(temporary, path);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      }),

    makeDirectory: (path, options) =>
      wrap(path, async () => {
        const created = await mkdir(path, { recursive: true });
        if (options.hidden && created !== undefined && process.platform === 'win32') {
          // Node has no API for the Windows hidden attribute; attrib.exe ships with Windows.
          await run('attrib', ['+H', path], { windowsHide: true });
        }
      }),
  };
}
