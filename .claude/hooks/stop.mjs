// @ts-check
/**
 * Stop and SubagentStop hook. Runs `npm run verify:fast` and `npm run check-logs`; when either is
 * red it exits 2 with the first failures so the agent keeps working instead of stopping.
 *
 * - stop_hook_active: Claude Code sets it when the agent is already continuing because of a stop
 *   hook. Then this hook lets the stop through, so it can never loop.
 * - A green result is remembered for the exact working-tree state, so a turn that changed nothing
 *   does not re-run the gates.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseJson } from '../../scripts/lib/json.mjs';
import { isRecord, logHook, projectDir, readInput, run, stringField, stripAnsi } from './lib.mjs';

const input = readInput();
const event = stringField(input, 'hook_event_name') ?? 'Stop';
const hookName = event === 'SubagentStop' ? 'subagent-stop' : 'stop';

if (input.stop_hook_active === true) {
  logHook(hookName, 'skipped: stop_hook_active is set (already continuing after a stop hook)');
  process.exit(0);
}

// A subagent may work in its own git worktree; check the tree it worked in.
const inputCwd = stringField(input, 'cwd');
const cwd =
  inputCwd !== undefined && existsSync(join(inputCwd, 'package.json'))
    ? resolve(inputCwd)
    : projectDir;

if (!existsSync(join(cwd, 'node_modules'))) {
  logHook(hookName, `blocked: node_modules missing in ${cwd}`);
  process.stderr.write(
    'Stop blocked: node_modules is missing, so the gates cannot run. Run npm ci, then finish.\n',
  );
  process.exit(2);
}

const stateFile = join(projectDir, '.claude', 'logs', 'last-green.json');
const fingerprint = treeFingerprint(cwd);
if (fingerprint !== undefined && readLastGreen() === `${cwd}:${fingerprint}`) {
  logHook(hookName, 'skipped: nothing changed since the last green verify:fast + check-logs');
  process.exit(0);
}

const started = Date.now();
const verify = run('npm', ['run', 'verify:fast'], { cwd, timeoutMs: 900_000 });
if (verify.status !== 0) {
  report('npm run verify:fast', verify.output);
}
const logs = run('npm', ['run', 'check-logs'], { cwd, timeoutMs: 60_000 });
if (logs.status !== 0) {
  report('npm run check-logs', logs.output);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
logHook(hookName, `ran npm run verify:fast and npm run check-logs: green in ${seconds}s`);
if (fingerprint !== undefined) {
  mkdirSync(join(projectDir, '.claude', 'logs'), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ tree: `${cwd}:${fingerprint}`, at: new Date().toISOString() }),
  );
}
process.exit(0);

/**
 * Exits 2 with the first failures of a red step.
 * @param {string} step
 * @param {string} output
 * @returns {never}
 */
function report(step, output) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.trim() !== '' &&
        !line.startsWith('> ') &&
        !/^npm (error|ERR!) (Lifecycle|code|path|command|workspace|location|A complete log)/.test(
          line,
        ),
    );
  const interesting = lines.filter((line) =>
    /error|fail|✗|×|warn|\[(warning|deprecation|unhandled|console|browser|experimental|Node)|problem|finding|Code style issues|^\s+\d+:\d+|\.([cm]?[jt]s|json|md|ya?ml)$/i.test(
      line,
    ),
  );
  const shown = (interesting.length > 0 ? interesting : lines.slice(-25)).slice(0, 25);
  logHook(hookName, `ran ${step}: red (${String(shown.length)} line(s) reported)`);
  process.stderr.write(
    `Stop blocked: ${step} is red. Fix these, then finish:\n${shown.map((line) => `  ${line}`).join('\n')}\n`,
  );
  process.exit(2);
}

/**
 * A hash of HEAD plus every uncommitted change (tracked diff and untracked files), or undefined
 * outside a git repository.
 * @param {string} dir
 * @returns {string | undefined}
 */
function treeFingerprint(dir) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10_000 });
  if (head.status !== 0) {
    return undefined;
  }
  const hash = createHash('sha256').update(head.output);
  hash.update(run('git', ['diff', 'HEAD', '--binary'], { cwd: dir, timeoutMs: 30_000 }).output);
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: dir,
    timeoutMs: 30_000,
  });
  for (const file of untracked.output.split('\0').filter((name) => name !== '')) {
    hash.update(file);
    try {
      hash.update(readFileSync(join(dir, file)));
    } catch {
      hash.update('<unreadable>');
    }
  }
  return hash.digest('hex');
}

/** @returns {string | undefined} */
function readLastGreen() {
  try {
    const parsed = parseJson(readFileSync(stateFile, 'utf8'));
    return isRecord(parsed) ? stringField(parsed, 'tree') : undefined;
  } catch {
    return undefined;
  }
}
