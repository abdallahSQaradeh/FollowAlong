// @ts-check
/**
 * Shared helpers for the Claude Code hooks in this folder. Node only (no bash), so they run the
 * same on Windows and Linux.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJson } from '../../scripts/lib/json.mjs';

/** The repository root: $CLAUDE_PROJECT_DIR when Claude Code sets it, else two folders up. */
export const projectDir = resolve(
  process.env.CLAUDE_PROJECT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
);

/**
 * Reads the hook's JSON input from stdin.
 * @returns {Record<string, unknown>}
 */
export function readInput() {
  let text;
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  if (text.trim() === '') {
    return {};
  }
  const parsed = parseJson(text);
  return isRecord(parsed) ? parsed : {};
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {string | undefined}
 */
export function stringField(record, key) {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Appends one line to .claude/logs/hooks.log: when, which hook, what it ran and the result.
 * @param {string} hook
 * @param {string} message
 */
export function logHook(hook, message) {
  const dir = join(projectDir, '.claude', 'logs');
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hooks.log'), `${new Date().toISOString()} ${hook}: ${message}\n`);
  } catch {
    // A hook must still do its job when the log cannot be written (for example a read-only checkout).
  }
}

/**
 * @typedef {{ status: number, output: string }} RunResult
 */

/**
 * Runs a command without a shell and returns its exit status and combined output.
 * On Windows, `npm` and `npx` are .cmd shims, so they go through cmd.exe explicitly.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {RunResult}
 */
export function run(command, args, options = {}) {
  const isWindowsShim = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const [file, fileArgs] = isWindowsShim
    ? ['cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')]]
    : [command, args];
  const result = spawnSync(file, fileArgs, {
    cwd: options.cwd ?? projectDir,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsVerbatimArguments: isWindowsShim,
  });
  const output = `${result.stdout}${result.stderr}${result.error ? `\n${result.error.message}` : ''}`;
  return { status: result.status ?? 1, output };
}

/**
 * Runs a package binary from node_modules through Node, with no shell or .cmd shim.
 * @param {string} entry path of the binary's JavaScript entry, relative to node_modules
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {RunResult}
 */
export function runNodeBin(entry, args, options = {}) {
  const cwd = options.cwd ?? projectDir;
  return run(process.execPath, [join(cwd, 'node_modules', entry), ...args], options);
}

/** Strips ANSI colour codes from tool output. */
export function stripAnsi(/** @type {string} */ text) {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with the ESC control character.
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
