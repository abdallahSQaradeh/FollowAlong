// @ts-check
/**
 * Thin VS Code smoke test: compiles test/smoke/suite and runs it inside a real VS Code with
 * @vscode/test-electron. On Linux without a display it re-runs itself under xvfb-run.
 *
 * FOLLOWALONG_VSCODE_VERSION overrides the VS Code version (default: the engines.vscode floor).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

/** A free local port, so the suite can click in the player page over the DevTools protocol. */
const devToolsPort = await /** @type {Promise<number>} */ (
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolvePort(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  })
);

const workspace = mkdtempSync(join(tmpdir(), 'followalong-smoke-'));
// A fresh user-data folder per run, so no setting or state leaks between runs. Proxy support is
// off: with it on, VS Code's proxy agent wraps fetch() in the extension host and calls the
// deprecated url.parse() (DEP0169) as soon as a built-in extension fetches at startup (traced in
// CI to TypeScriptTeam.jsts-chat-features). The smoke test makes no network requests.
const userData = mkdtempSync(join(tmpdir(), 'followalong-smoke-user-'));
mkdirSync(join(userData, 'User'), { recursive: true });
writeFileSync(
  join(userData, 'User', 'settings.json'),
  `${JSON.stringify({ 'http.proxySupport': 'off' }, null, 2)}\n`,
);
try {
  await runTests({
    version,
    cachePath: join(root, '.vscode-test'),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'smoke', 'suite', 'index.js'),
    extensionTestsEnv: { FOLLOWALONG_SMOKE_DEVTOOLS_PORT: String(devToolsPort) },
    launchArgs: [
      workspace,
      // A real click in the player page needs real input events: test/smoke/suite/index.ts
      // sends them over the DevTools protocol, as a learner's mouse would.
      `--remote-debugging-port=${String(devToolsPort)}`,
      `--user-data-dir=${userData}`,
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
  // On Windows a VS Code process can hold its log files for a moment after the run ends (seen
  // once the suite had a DevTools connection open), so removal retries on EBUSY.
  const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 500 };
  rmSync(workspace, retry);
  rmSync(userData, retry);
}
