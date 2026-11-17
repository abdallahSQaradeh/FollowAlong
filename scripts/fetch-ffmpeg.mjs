// @ts-check
/**
 * Puts the bundled ffmpeg (ADR 0070) into bin/ on Windows, where scripts/build-ffmpeg.mjs cannot
 * run: it downloads the "ffmpeg-win32-x64" artifact of the newest successful CI run that still has
 * one, with the GitHub CLI (`gh`, signed in), then runs scripts/check-bundled-ffmpeg.mjs on it. The
 * extension run from the repository (F5) and `npm run package` both take ffmpeg from bin/.
 *
 * Usage: npm run fetch-ffmpeg [-- --branch <branch>]
 *   --branch  only runs of this branch (default: any branch)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = 'ffmpeg-win32-x64';
/** @type {unknown} */
const pinnedJson = JSON.parse(readFileSync(join(root, 'scripts', 'bundled-ffmpeg.json'), 'utf8'));
const outputs = /** @type {{ outputs: string[] }} */ (pinnedJson).outputs;
const argv = process.argv.slice(2);
const branchAt = argv.indexOf('--branch');
const branch = branchAt >= 0 ? argv[branchAt + 1] : undefined;

/**
 * Runs gh and returns what it printed; exits with its error when it fails.
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 */
function gh(args, options = {}) {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  if (result.error !== undefined) {
    console.error(
      `fetch-ffmpeg: could not run gh (${result.error.message}). Install the GitHub CLI and run gh auth login.`,
    );
    process.exit(1);
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    console.error(`fetch-ffmpeg: gh ${args.join(' ')} failed:\n${result.stderr}`);
    process.exit(1);
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

const list = gh([
  'run',
  'list',
  '--workflow',
  'CI',
  '--status',
  'success',
  '--limit',
  '30',
  '--json',
  'databaseId,headBranch,createdAt',
  ...(branch === undefined ? [] : ['--branch', branch]),
]);
/** @type {unknown} */
const runsJson = JSON.parse(list.stdout);
const runs = /** @type {{ databaseId: number, headBranch: string, createdAt: string }[]} */ (
  runsJson
);

const work = mkdtempSync(join(tmpdir(), 'followalong-fetch-ffmpeg-'));
try {
  const found = runs.find((run) => {
    const folder = join(work, String(run.databaseId));
    const download = gh(
      ['run', 'download', String(run.databaseId), '--name', artifact, '--dir', folder],
      { allowFailure: true },
    );
    if (download.ok) {
      console.log(
        `Downloaded ${artifact} of CI run ${String(run.databaseId)} (${run.headBranch}).`,
      );
    }
    return download.ok;
  });
  if (found === undefined) {
    console.error(
      `fetch-ffmpeg: none of the last ${String(runs.length)} successful CI runs${branch === undefined ? '' : ` of ${branch}`} has a ${artifact} artifact (they expire). Re-run CI, or build it on Linux: node scripts/build-ffmpeg.mjs.`,
    );
    process.exit(1);
  }

  const from = join(work, String(found.databaseId));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of outputs) {
    copyFileSync(join(from, name), join(bin, name));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const check = spawnSync(process.execPath, [join(root, 'scripts', 'check-bundled-ffmpeg.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(check.status ?? 1);
