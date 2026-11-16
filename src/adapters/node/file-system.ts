/**
 * The File system port over Node's `fs`. Used by the extension and, as the real file system, by
 * Seam 1 tests. Failures become a FileSystemError whose `reason` is the read-only check.
 */
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
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

/**
 * On Windows, replacing a file another process has open for a moment (an antivirus scan, a second
 * VS Code window writing the same Course data) fails with EPERM, EACCES or EBUSY. Retry briefly.
 */
async function renameOver(from: string, to: string): Promise<void> {
  const delaysMs = [20, 50, 100, 200, 400];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const delay = delaysMs[attempt];
      if (delay === undefined || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

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

    exists: (path) =>
      stat(path).then(
        () => true,
        (error: unknown) => reasonOf(error) !== 'notFound',
      ),

    writeText: (path, content) =>
      wrap(path, async () => {
        // Write beside the target, then rename over it, so a reader never sees half a file.
        temporaryCounter += 1;
        const temporary = join(
          dirname(path),
          `.${basename(path)}.${String(process.pid)}-${String(temporaryCounter)}.tmp`,
        );
        try {
          const file = await open(temporary, 'w');
          try {
            await file.writeFile(content, 'utf8');
            // On disk before the rename, so a crash cannot leave an empty file under the real name.
            await file.sync();
          } finally {
            await file.close();
          }
        } catch (error) {
          // A full disk, say: leave no half-written temp file behind, and report the first error.
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        try {
          await renameOver(temporary, path);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          // Still EPERM/EACCES after the retries: the file cannot be replaced (a read-only
          // attribute, another owner), so the data has to go elsewhere, like a read-only Course.
          throw error;
        }
      }),

    makeDirectory: (path, options) =>
      wrap(path, async () => {
        try {
          await mkdir(path, { recursive: options.parents });
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? error.code : undefined;
          const isFolder =
            code === 'EEXIST' &&
            (await stat(path).then(
              (found) => found.isDirectory(),
              () => false,
            ));
          if (!isFolder) {
            if (code === 'EEXIST' || (options.parents && code === 'ENOTDIR')) {
              // A file is in the way: no folder can be made at this path.
              throw new FileSystemError('readOnly', path, `${path} exists and is not a folder.`);
            }
            throw error;
          }
        }
        // Also for a folder that already existed: it may have been made without the attribute.
        if (options.hidden && process.platform === 'win32') {
          // Node has no API for the Windows hidden attribute; attrib.exe ships with Windows.
          await run('attrib', ['+H', path], { windowsHide: true });
        }
      }),
  };
}
