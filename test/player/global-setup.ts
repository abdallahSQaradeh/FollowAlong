/** Seam 2 runs against the shipped player bundle, so build it first. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export default function globalSetup(): void {
  const root = resolve(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`The build failed (status ${String(result.status)}).`);
  }
}
