/**
 * Makes a fixture folder really read-only for the current user, on each OS CI runs:
 * - Windows: an ACL entry that denies Everyone creating files or folders in it (the read-only
 *   attribute does not stop that on Windows folders);
 * - Linux as root (cloud sessions): the immutable attribute, since root ignores permission bits;
 * - otherwise: permission bits r-x.
 * It then checks that a write really fails, so a test can never pass against a writable folder.
 * The change is undone when the test finishes, so the temp dir can be removed.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { onTestFinished } from 'vitest';

const everyone = '*S-1-1-0';

/** Returns a function that makes the folder writable again (also done when the test finishes). */
export function makeReadOnly(folder: string): () => void {
  let undo: () => void;
  if (process.platform === 'win32') {
    execFileSync('icacls', [folder, '/deny', `${everyone}:(WD,AD,WEA,WA,DC)`], { stdio: 'ignore' });
    undo = () => execFileSync('icacls', [folder, '/remove:d', everyone], { stdio: 'ignore' });
  } else if (process.getuid?.() === 0) {
    execFileSync('chattr', ['+i', folder]);
    undo = () => execFileSync('chattr', ['-i', folder]);
  } else {
    chmodSync(folder, 0o555);
    undo = () => {
      chmodSync(folder, 0o755);
    };
  }
  let undone = false;
  const undoOnce = () => {
    if (!undone) {
      undone = true;
      undo();
    }
  };
  onTestFinished(undoOnce);

  const probe = join(folder, 'write-probe');
  let writable = true;
  try {
    writeFileSync(probe, '');
    rmSync(probe);
  } catch {
    writable = false;
  }
  if (writable) {
    throw new Error(`makeReadOnly: ${folder} is still writable in this environment.`);
  }
  return undoOnce;
}

/** Whether a file or folder is hidden: the Windows hidden attribute, or a leading dot elsewhere. */
export function isHidden(path: string): boolean {
  if (process.platform === 'win32') {
    // attrib prints the attribute letters, then the path: "A   H        C:\\…\\.followalong".
    const line = execFileSync('attrib', [path], { encoding: 'utf8' });
    return line.slice(0, line.indexOf(path)).includes('H');
  }
  return basename(path).startsWith('.');
}
