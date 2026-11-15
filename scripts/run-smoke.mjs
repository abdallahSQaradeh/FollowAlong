// @ts-check
/**
 * Thin VS Code smoke test: compiles test/smoke/suite and runs it inside a real VS Code with
 * @vscode/test-electron. On Linux without a display it re-runs itself under xvfb-run.
 *
 * FOLLOWALONG_VSCODE_VERSION overrides the VS Code version (default: the engines.vscode floor).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';

import { build } from './build.mjs';
import { readJson } from './lib/json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'linux' && !process.env.DISPLAY) {
  const which = spawnSync('which', ['xvfb-run']);
  if (which.status !== 0) {
    console.error(
      'run-smoke: no DISPLAY and no xvfb-run. Install xvfb (the SessionStart hook does).',
    );
    process.exit(2);
  }
  const rerun = spawnSync(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1280x800x24', process.execPath, fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(rerun.status ?? 1);
}

const manifest = /** @type {{ engines: { vscode: string } }} */ (
  readJson(join(root, 'package.json'))
);
const version =
  process.env.FOLLOWALONG_VSCODE_VERSION ?? manifest.engines.vscode.replace(/^\^/, '');

const compile = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.smoke.json')],
  { stdio: 'inherit' },
);
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}
// VS Code loads the extension from package.json "main", the bundle in out/.
await build();

const workspace = mkdtempSync(join(tmpdir(), 'followalong-smoke-'));
try {
  await runTests({
    version,
    cachePath: join(root, '.vscode-test'),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'smoke', 'suite', 'index.js'),
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
  console.log(`run-smoke: passed on VS Code ${version}`);
} catch (error) {
  console.error(
    `run-smoke: failed on VS Code ${version}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
