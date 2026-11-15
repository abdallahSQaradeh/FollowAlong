// @ts-check
/**
 * SessionStart hook. Makes the gates runnable before the agent's first message:
 * - installs xvfb (for the smoke test) and ffmpeg (for media fixtures) with apt when missing,
 *   on Linux only;
 * - runs `npm ci` when node_modules is missing or stale (package.json, package-lock.json or this
 *   script changed since the last successful install);
 * - prints the tool versions, which Claude Code adds to the session's context.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logHook, projectDir, readInput, run, runNodeBin, stringField } from './lib.mjs';

const input = readInput();
const source = stringField(input, 'source') ?? 'startup';
/** @type {string[]} */
const notes = [];

// 1. System packages (Linux with apt only; Windows and macOS developers install their own).
if (process.platform === 'linux' && run('which', ['apt-get'], { timeoutMs: 5_000 }).status === 0) {
  /** @type {string[]} */
  const missing = [];
  if (run('which', ['xvfb-run'], { timeoutMs: 5_000 }).status !== 0) {
    missing.push('xvfb');
  }
  if (run('which', ['ffmpeg'], { timeoutMs: 5_000 }).status !== 0) {
    missing.push('ffmpeg');
  }
  if (missing.length > 0) {
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
    /** @param {string[]} args */
    const apt = (args) =>
      asRoot
        ? run('apt-get', args, { env, timeoutMs: 600_000 })
        : run('sudo', ['-n', 'apt-get', ...args], { env, timeoutMs: 600_000 });
    const update = apt(['update']);
    const install = apt(['install', '-y', '--no-install-recommends', ...missing]);
    const ok = update.status === 0 && install.status === 0;
    notes.push(
      ok ? `apt: installed ${missing.join(', ')}` : `apt: could not install ${missing.join(', ')}`,
    );
    logHook('session-start', `apt-get install ${missing.join(' ')}: ${ok ? 'ok' : 'failed'}`);
  }
}

// 2. npm ci when node_modules is missing or stale. The hash file lives inside node_modules, so it
//    disappears with the packages.
const hashFile = join(projectDir, 'node_modules', '.session-start.sha256');
const inputsHash = createHash('sha256');
for (const file of ['package.json', 'package-lock.json']) {
  const path = join(projectDir, file);
  inputsHash.update(existsSync(path) ? readFileSync(path) : '');
}
inputsHash.update(readFileSync(fileURLToPath(import.meta.url)));
const wanted = inputsHash.digest('hex');
const current = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : '';
if (existsSync(join(projectDir, 'package-lock.json')) && current !== wanted) {
  const started = Date.now();
  const install = run('npm', ['ci', '--no-audit', '--no-fund'], { timeoutMs: 900_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (install.status === 0) {
    writeFileSync(hashFile, `${wanted}\n`);
    notes.push(`npm ci: done in ${seconds}s`);
    logHook('session-start', `npm ci: ok in ${seconds}s (source=${source})`);
  } else {
    notes.push(
      'npm ci: FAILED. The gates cannot run until it succeeds; run npm ci and read its error.',
    );
    logHook('session-start', `npm ci: failed (source=${source})`);
    process.stderr.write(install.output.slice(-4000));
  }
} else {
  logHook('session-start', `npm ci: skipped, node_modules is current (source=${source})`);
}

// 3. Versions, for the agent's context.
/**
 * @param {string} label
 * @param {() => { status: number, output: string }} probe
 * @returns {string}
 */
function version(label, probe) {
  const result = probe();
  const first = result.output.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return `${label} ${result.status === 0 ? first.trim() : 'missing'}`;
}
const haveModules = existsSync(join(projectDir, 'node_modules'));
const versions = [
  `node ${process.version}`,
  version('npm', () => run('npm', ['--version'], { timeoutMs: 20_000 })),
  version('git', () => run('git', ['--version'], { timeoutMs: 5_000 })),
  ...(haveModules
    ? [
        version('typescript', () => runNodeBin('typescript/bin/tsc', ['--version'])),
        version('eslint', () => runNodeBin('eslint/bin/eslint.js', ['--version'])),
        version('prettier', () => runNodeBin('prettier/bin/prettier.cjs', ['--version'])),
        version('vitest', () => runNodeBin('vitest/vitest.mjs', ['--version'])),
        version('playwright', () => runNodeBin('@playwright/test/cli.js', ['--version'])),
      ]
    : []),
  version('ffmpeg', () => run('ffmpeg', ['-hide_banner', '-version'], { timeoutMs: 10_000 })),
  process.platform === 'linux'
    ? `xvfb-run ${run('which', ['xvfb-run'], { timeoutMs: 5_000 }).status === 0 ? 'present' : 'missing'}`
    : '',
].filter((line) => line !== '');

logHook('session-start', `versions: ${versions.join('; ')}`);
process.stdout.write(
  [
    'FollowAlong session start.',
    ...notes,
    `Tools: ${versions.join('; ')}`,
    'Gates: hooks format+lint+typecheck each edited file; Stop runs npm run verify:fast and npm run check-logs.',
    'Read CODING_STANDARDS.md before writing code.',
  ].join('\n') + '\n',
);
