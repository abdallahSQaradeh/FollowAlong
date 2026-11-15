// @ts-check
/**
 * Scans the newest log of each test script in .logs/ and fails on anything that signals a problem
 * the test run itself did not fail on: warnings, deprecations, unhandled rejections, console.warn or
 * console.error output from tests, and Node "(node:" / "Experimental" notices.
 *
 * Known, accepted noise goes in scripts/check-logs.allow.json. Every entry needs a written reason.
 *
 * Usage: node scripts/check-logs.mjs [--logs <dir>] [--allow <file>]
 * Exit codes: 0 clean, 1 findings, 2 bad allowlist or usage.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson } from './lib/json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logsDir = resolve(root, option('--logs') ?? '.logs');
const allowPath = resolve(root, option('--allow') ?? 'scripts/check-logs.allow.json');
const maxPrinted = 40;
const minReasonLength = 15;

/** @typedef {{ kind: string, pattern: RegExp }} Rule */
/** @type {Rule[]} */
const rules = [
  { kind: 'warning', pattern: /\bwarn(ing)?s?\b/i },
  { kind: 'deprecation', pattern: /deprecat/i },
  { kind: 'unhandled rejection or error', pattern: /unhandled\s*(promise\s*)?(rejection|error)/i },
  // Vitest prints console.warn and console.error from a test as "stderr | <file> > <test>".
  { kind: 'console.warn/console.error from a test', pattern: /^stderr \| / },
  // test/player/fixtures.ts tags browser console warnings, errors and page errors.
  { kind: 'browser console output', pattern: /^\[browser (console\.\w+|pageerror)\]/ },
  { kind: 'experimental notice', pattern: /experimental/i },
  { kind: 'Node process notice', pattern: /\(node:\d+\)/ },
];

/** @typedef {{ pattern: RegExp, source: string, reason: string, logs: string[] | undefined, used: number }} AllowEntry */
const allowlist = readAllowlist(allowPath);

if (!existsSync(logsDir)) {
  console.log(`check-logs: no ${relative(root, logsDir) || logsDir} folder yet, nothing to scan.`);
  process.exit(0);
}

const latest = latestLogPerScript(logsDir);
/** @type {string[]} */
const findings = [];
for (const [script, file] of latest) {
  const text = readFileSync(join(logsDir, file), 'utf8');
  const lines = stripAnsi(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    const rule = rules.find((candidate) => candidate.pattern.test(line));
    if (rule === undefined) {
      return;
    }
    const allowed = allowlist.find(
      (entry) =>
        (entry.logs === undefined || entry.logs.includes(script)) && entry.pattern.test(line),
    );
    if (allowed !== undefined) {
      allowed.used += 1;
      return;
    }
    findings.push(
      `.logs/${file}:${String(index + 1)}: [${rule.kind}] ${line.trim().slice(0, 300)}`,
    );
  });
}

const scanned = [...latest.values()].map((file) => `.logs/${file}`);
console.log(
  `check-logs: scanned ${String(scanned.length)} log(s): ${scanned.join(', ') || 'none'}`,
);
const unused = allowlist.filter((entry) => entry.used === 0);
if (unused.length > 0) {
  console.log(
    `check-logs: allowlist entries that matched nothing this run: ${unused.map((entry) => entry.source).join(', ')}`,
  );
}
if (findings.length === 0) {
  console.log('check-logs: clean.');
  process.exit(0);
}
console.error(
  `check-logs: ${String(findings.length)} finding(s). Fix the cause; allowlist only noise you cannot fix, with a reason.`,
);
for (const finding of findings.slice(0, maxPrinted)) {
  console.error(`  ${finding}`);
}
if (findings.length > maxPrinted) {
  console.error(`  … and ${String(findings.length - maxPrinted)} more.`);
}
process.exit(1);

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Picks the newest log for each script. Log names are "<script>-<ISO timestamp>.log", so the
 * lexical order of names with the same script is their time order.
 * @param {string} dir
 * @returns {Map<string, string>}
 */
function latestLogPerScript(dir) {
  /** @type {Map<string, string>} */
  const newest = new Map();
  for (const file of readdirSync(dir).sort()) {
    const match = /^(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.log$/.exec(file);
    const script = match?.[1];
    if (script !== undefined) {
      newest.set(script, file);
    }
  }
  return newest;
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with the ESC control character.
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Reads and validates the allowlist. An entry without a real reason is an error, not a warning.
 * @param {string} path
 * @returns {AllowEntry[]}
 */
function readAllowlist(path) {
  if (!existsSync(path)) {
    return [];
  }
  const parsed = readJson(path);
  const entries = isRecord(parsed) ? parsed.entries : undefined;
  if (!Array.isArray(entries)) {
    fail(`${relative(root, path)} must be an object with an "entries" array.`);
  }
  return entries.map((/** @type {unknown} */ raw, /** @type {number} */ index) => {
    const where = `${relative(root, path)} entry ${String(index)}`;
    if (!isRecord(raw)) {
      fail(`${where} must be an object.`);
    }
    const { pattern, reason, logs } = raw;
    if (typeof pattern !== 'string' || pattern.length === 0) {
      fail(`${where} needs a "pattern" (a regular expression string).`);
    }
    if (typeof reason !== 'string' || reason.trim().length < minReasonLength) {
      fail(`${where} needs a written "reason" of at least ${String(minReasonLength)} characters.`);
    }
    if (
      logs !== undefined &&
      !(Array.isArray(logs) && logs.every((item) => typeof item === 'string'))
    ) {
      fail(`${where} has "logs", which must be a list of script log names such as "test-smoke".`);
    }
    return { pattern: new RegExp(pattern), source: pattern, reason, logs, used: 0 };
  });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`check-logs: ${message}`);
  process.exit(2);
}
