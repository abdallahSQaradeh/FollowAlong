// @ts-check
/**
 * PostToolUse hook for Edit, Write, MultiEdit and NotebookEdit. On the touched file it runs
 * prettier --write and eslint --fix, then reports what is left: ESLint problems and type errors
 * (a type check of the tsconfig project the file belongs to, reported for that file).
 * Problems exit 2 with a short summary on stderr, so the agent fixes them right away.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import { parseJson } from '../../scripts/lib/json.mjs';
import {
  isRecord,
  logHook,
  projectDir,
  readInput,
  runNodeBin,
  stringField,
  stripAnsi,
} from './lib.mjs';

const lintable = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const skippedFolders =
  /^(node_modules|out|\.logs|\.claude\/logs|\.claude\/skills|\.vscode-test|test-results|playwright-report|coverage)\//;
const maxShown = 12;

const input = readInput();
const tool = stringField(input, 'tool_name') ?? '';
const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
const filePath = stringField(toolInput, 'file_path') ?? stringField(toolInput, 'notebook_path');
if (filePath === undefined) {
  process.exit(0);
}
const absolute = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
const file = relative(projectDir, absolute).replace(/\\/g, '/');
if (file.startsWith('..') || skippedFolders.test(file) || !existsSync(absolute)) {
  logHook('post-edit', `${tool} ${file}: skipped (outside the checked tree or deleted)`);
  process.exit(0);
}
if (!existsSync(resolve(projectDir, 'node_modules', 'prettier'))) {
  logHook('post-edit', `${tool} ${file}: skipped (node_modules missing)`);
  process.stderr.write('post-edit: node_modules is missing, so nothing was checked. Run npm ci.\n');
  process.exit(2);
}

/** @type {string[]} */
const ran = [];
/** @type {string[]} */
const problems = [];
let otherTypeErrors = 0;

// 1. Format. --ignore-unknown skips file types Prettier has no parser for.
const prettierArgs = ['--write', '--ignore-unknown', '--log-level', 'warn', absolute];
const formatted = runNodeBin('prettier/bin/prettier.cjs', prettierArgs, { timeoutMs: 60_000 });
ran.push(`prettier=${String(formatted.status)}`);
if (formatted.status !== 0) {
  problems.push(...firstLines(`prettier: ${stripAnsi(formatted.output)}`));
}

if (lintable.has(extname(file))) {
  // 2. Lint with fixes; the JSON report lists what --fix could not fix.
  const before = readFileSync(absolute, 'utf8');
  const lint = runNodeBin(
    'eslint/bin/eslint.js',
    ['--fix', '--no-warn-ignored', '--format', 'json', absolute],
    { timeoutMs: 120_000 },
  );
  ran.push(`eslint --fix=${String(lint.status)}`);
  problems.push(...eslintProblems(lint.output));
  if (readFileSync(absolute, 'utf8') !== before) {
    runNodeBin('prettier/bin/prettier.cjs', prettierArgs, { timeoutMs: 60_000 });
  }

  // 3. Type check the project, report this file's errors (and count the others).
  const project = tsconfigFor(file);
  if (project !== undefined) {
    const types = runNodeBin(
      'typescript/bin/tsc',
      ['-p', project, '--noEmit', '--pretty', 'false'],
      { timeoutMs: 180_000 },
    );
    ran.push(`tsc -p ${project}=${String(types.status)}`);
    for (const line of stripAnsi(types.output).split(/\r?\n/)) {
      const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
      if (match === null) {
        continue;
      }
      const errorFile = (match[1] ?? '').replace(/\\/g, '/');
      if (errorFile === file) {
        problems.push(`${match[2] ?? ''}:${match[3] ?? ''} ${match[4] ?? ''} ${match[5] ?? ''}`);
      } else {
        otherTypeErrors += 1;
      }
    }
  }
}

const note =
  otherTypeErrors > 0
    ? `${String(otherTypeErrors)} type error(s) in other files (run npm run typecheck).`
    : '';
if (problems.length === 0) {
  logHook('post-edit', `${tool} ${file}: ran ${ran.join(', ')}: clean${note ? `; ${note}` : ''}`);
  if (note) {
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `post-edit: ${file} is clean, but ${note}` } })}\n`,
    );
  }
  process.exit(0);
}

logHook(
  'post-edit',
  `${tool} ${file}: ran ${ran.join(', ')}: blocked, ${String(problems.length)} problem(s)`,
);
const shown = problems.slice(0, maxShown).map((problem) => `  ${problem}`);
if (problems.length > maxShown) {
  shown.push(`  … and ${String(problems.length - maxShown)} more`);
}
process.stderr.write(
  `post-edit: ${file} has ${String(problems.length)} problem(s) left after prettier and eslint --fix. Fix them now:\n${shown.join('\n')}${note ? `\n${note}` : ''}\n`,
);
process.exit(2);

/**
 * @param {string} output ESLint's JSON report
 * @returns {string[]}
 */
function eslintProblems(output) {
  const start = output.indexOf('[');
  let report;
  try {
    report = parseJson(output.slice(start));
  } catch {
    return start === -1 && output.trim() === '' ? [] : firstLines(`eslint: ${stripAnsi(output)}`);
  }
  if (!Array.isArray(report)) {
    return [];
  }
  /** @type {string[]} */
  const found = [];
  for (const result of report) {
    const messages = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
    for (const message of messages) {
      if (!isRecord(message)) {
        continue;
      }
      const line = typeof message.line === 'number' ? message.line : 0;
      const column = typeof message.column === 'number' ? message.column : 0;
      const rule = stringField(message, 'ruleId') ?? 'parse';
      found.push(
        `${String(line)}:${String(column)} eslint(${rule}) ${stringField(message, 'message') ?? ''}`,
      );
    }
  }
  return found;
}

/**
 * The tsconfig that owns a file: the root project covers everything it includes.
 * @param {string} relativeFile
 * @returns {string | undefined}
 */
function tsconfigFor(relativeFile) {
  const root = resolve(projectDir, 'tsconfig.json');
  if (!existsSync(root)) {
    return undefined;
  }
  const config = parseJson(readFileSync(root, 'utf8'));
  const include = isRecord(config) && Array.isArray(config.include) ? config.include : [];
  const covered = include.some((entry) => {
    if (typeof entry !== 'string') {
      return false;
    }
    if (entry.startsWith('*')) {
      return !relativeFile.includes('/') && relativeFile.endsWith(entry.slice(1));
    }
    return relativeFile === entry || relativeFile.startsWith(`${entry}/`);
  });
  return covered ? 'tsconfig.json' : undefined;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function firstLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 6);
}
