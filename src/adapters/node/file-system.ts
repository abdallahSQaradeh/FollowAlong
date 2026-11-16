/**
 * The File system port over Node's `fs`. Used by the extension and, as the real file system, by
 * Seam 1 tests. Failures become a FileSystemError whose `reason` is the read-only check.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  FileSystemError,
  type DirectoryEntry,
  type FileSystem,
  type FileSystemErrorReason,
  type ReleaseLock,
} from '../../core/ports.js';

const run = promisify(execFile);

/** The Node error code of `error` (`ENOENT`, …), if it has one. */
function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function reasonOf(error: unknown): FileSystemErrorReason {
  switch (codeOf(error)) {
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
      const code = codeOf(error);
      const delay = delaysMs[attempt];
      if (delay === undefined || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** How long a window waits for another window's lock on a file, in steps of `lockStepMs`. */
const lockWaitMs = 2_000;
const lockStepMs = 20;
/** A lock this old was left behind by a window that stopped before giving it back. */
const leftBehindLockMs = 10_000;

/** What the lock file at `lockPath` holds: the token of the window that made it, if any. */
async function lockToken(lockPath: string): Promise<string | undefined> {
  return readFile(lockPath, 'utf8').then(
    (token) => token,
    () => undefined,
  );
}

/** Whether anything is at `path`. */
async function present(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Makes `lockPath` holding `token` if nothing is there; `false` while another window holds it. */
async function makeLock(lockPath: string, token: string): Promise<boolean> {
  try {
    const file = await open(lockPath, 'wx');
    try {
      await file.writeFile(token, 'utf8');
    } finally {
      await file.close();
    }
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === 'EEXIST') {
      return false;
    }
    // On Windows, a lock file another window is just removing refuses to be made again (EPERM):
    // held for a moment more. A folder that may not be written to refuses it too, with no file.
    if ((code === 'EPERM' || code === 'EACCES') && (await present(lockPath))) {
      return false;
    }
    throw error;
  }
}

/**
 * Removes the lock at `lockPath` when it still holds `token`. Another window may have taken it over
 * in between (it looked left behind): that lock is its, and stays. Only the moment between this
 * look and the removal is left open.
 */
async function removeLockOf(lockPath: string, token: string): Promise<void> {
  if ((await lockToken(lockPath)) === token) {
    await rm(lockPath, { force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/**
 * Takes over the lock at `lockPath` when it was left behind. Failing to remove it (on Windows,
 * another process may hold it for a moment) is not a reason to call the folder read-only: the
 * caller waits on, and gives up in time.
 */
async function takeOverLeftBehind(lockPath: string): Promise<void> {
  const token = await lockToken(lockPath);
  const old = await stat(lockPath).then(
    (found) => Date.now() - found.mtimeMs >= leftBehindLockMs,
    () => false,
  );
  if (token !== undefined && old) {
    await removeLockOf(lockPath, token).catch(() => undefined);
  }
}

/** See {@link FileSystem.lock}. */
async function lock(path: string): Promise<ReleaseLock> {
  const lockPath = `${path}.lock`;
  const token = `${String(process.pid)}-${randomUUID()}`;
  const giveUpAt = Date.now() + lockWaitMs;
  for (;;) {
    if (await makeLock(lockPath, token)) {
      return () => wrap(lockPath, () => removeLockOf(lockPath, token));
    }
    await takeOverLeftBehind(lockPath);
    if (Date.now() >= giveUpAt) {
      throw new FileSystemError('other', path, `${lockPath} is still held by another window.`);
    }
    if (await present(lockPath)) {
      await new Promise((resolve) => setTimeout(resolve, lockStepMs));
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

    stat: (path) =>
      wrap(path, async () => {
        const found = await stat(path);
        return { size: found.size, modifiedMs: found.mtimeMs };
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

    lock: (path) => wrap(path, () => lock(path)),

    makeDirectory: (path, options) =>
      wrap(path, async () => {
        try {
          await mkdir(path, { recursive: options.parents });
        } catch (error) {
          const code = codeOf(error);
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
