// @ts-check
/**
 * Pure checks behind the PreToolUse hooks. Each returns the reasons a command or edit must be
 * blocked (an empty list lets it through).
 */
import { isRecord } from './lib.mjs';
import { parseJson } from '../../scripts/lib/json.mjs';

/** Branches nobody force-pushes to, deletes or hard-resets. */
const protectedBranch = /^(main|integration\/.+)$/;

/**
 * Files that define the quality gates. The shell may read them but not write them: changes go
 * through the Edit tool, where checkEdit() can see whether they loosen a rule.
 */
const gateFiles = [
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^\.prettierrc(\.json)?$/,
  /^\.prettierignore$/,
  /^\.editorconfig$/,
  /^\.gitattributes$/,
  /^\.lintstagedrc(\.json)?$/,
  /^package\.json$/,
  /^\.husky\/[^/]+$/,
  /^\.claude\/settings\.json$/,
  /^\.claude\/hooks\/[^/]+$/,
  /^scripts\/(check-logs|run-logged|run-smoke)\.mjs$/,
  /^scripts\/check-logs\.allow\.json$/,
  /^scripts\/lib\/[^/]+$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^playwright\.config\.[cm]?[jt]s$/,
  /^\.github\/workflows\/[^/]+$/,
];

/**
 * @param {string} relativePath a path relative to the repository root, with forward slashes
 * @returns {boolean}
 */
export function isGateFile(relativePath) {
  return gateFiles.some((pattern) => pattern.test(relativePath));
}

// ---------------------------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} command the full Bash command line
 * @param {string | undefined} currentBranch the branch checked out where the command runs
 * @returns {string[]}
 */
export function checkBash(command, currentBranch) {
  /** @type {string[]} */
  const reasons = [];
  let branch = currentBranch;

  if (/(^|\s)--no-verify(\s|=|$)/.test(command)) {
    reasons.push('--no-verify skips the git hooks. Fix what the hook reports instead.');
  }
  if (/\bHUSKY=0\b|\bHUSKY_SKIP_HOOKS\b/.test(command)) {
    reasons.push('HUSKY=0 skips the git hooks. Fix what the hook reports instead.');
  }
  if (command.includes('core.hooksPath') && !/--get\b/.test(command)) {
    reasons.push('Changing core.hooksPath turns the git hooks off.');
  }

  for (const segment of segments(command)) {
    const tokens = withoutPrefix(tokenize(segment));
    const shellWrite = gateFileWrite(segment, tokens);
    if (shellWrite !== undefined) {
      reasons.push(
        `This command writes ${shellWrite}, a quality-gate file. Change it with the Edit tool so the loosening check can see the change.`,
      );
    }
    if (tokens[0] === 'npm' && tokens[1] === 'pkg' && /^(set|delete)$/.test(tokens[2] ?? '')) {
      reasons.push('npm pkg set/delete rewrites package.json. Change it with the Edit tool.');
    }
    if (tokens[0] !== 'git') {
      continue;
    }
    const args = gitArgs(tokens);
    const sub = args[0];
    if ((sub === 'checkout' || sub === 'switch') && args.length >= 2) {
      const target = args.slice(1).find((arg) => !arg.startsWith('-'));
      if (target !== undefined && !args.includes('--')) {
        branch = target;
      }
    }
    if (sub === 'commit' && args.slice(1).some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg))) {
      reasons.push('git commit -n is --no-verify: it skips the git hooks.');
    }
    if (sub === 'push') {
      reasons.push(...checkPush(args.slice(1), branch));
    }
    if (
      sub === 'reset' &&
      args.includes('--hard') &&
      branch !== undefined &&
      protectedBranch.test(branch)
    ) {
      reasons.push(`git reset --hard on ${branch} rewrites a protected branch.`);
    }
    if (
      sub === 'branch' &&
      args.some((arg) => /^-[A-Za-z]*[DfM]/.test(arg) || arg === '--force' || arg === '--delete')
    ) {
      const named = args.slice(1).filter((arg) => !arg.startsWith('-'));
      if (named.some((name) => protectedBranch.test(name))) {
        reasons.push('Deleting, moving or force-resetting main or integration/* is not allowed.');
      }
    }
  }
  return [...new Set(reasons)];
}

/**
 * @param {string[]} args the arguments after "git push"
 * @param {string | undefined} branch
 * @returns {string[]}
 */
function checkPush(args, branch) {
  const valueFlags = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
  /** @type {string[]} */
  const positional = [];
  let force = false;
  let remove = false;
  let everything = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (valueFlags.has(arg)) {
      index += 1;
    } else if (
      /^--force(-with-lease|-if-includes)?(=.*)?$/.test(arg) ||
      /^-[A-Za-z]*f[A-Za-z]*$/.test(arg)
    ) {
      force = true;
    } else if (arg === '--delete' || /^-[A-Za-z]*d[A-Za-z]*$/.test(arg)) {
      remove = true;
    } else if (arg === '--mirror' || arg === '--all' || arg === '--branches') {
      everything = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  const refspecs = positional.slice(1);
  /** @type {string[]} */
  const targets = [];
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) {
      force = true;
    }
    const spec = refspec.replace(/^\+/, '');
    const parts = spec.split(':');
    if (parts.length > 1 && parts[0] === '') {
      remove = true;
    }
    const destination = (parts.length > 1 ? parts[1] : parts[0]) ?? '';
    targets.push(
      destination === 'HEAD' ? (branch ?? 'HEAD') : destination.replace(/^refs\/heads\//, ''),
    );
  }
  if (refspecs.length === 0 && branch !== undefined) {
    targets.push(branch);
  }
  const hitsProtected = everything || targets.some((target) => protectedBranch.test(target));
  if (!hitsProtected) {
    return [];
  }
  /** @type {string[]} */
  const reasons = [];
  if (force) {
    reasons.push('Force-pushing to main or integration/* is not allowed.');
  }
  if (remove) {
    reasons.push('Deleting main or integration/* on the remote is not allowed.');
  }
  return reasons;
}

/**
 * Returns the gate file a shell segment writes to, if any.
 * @param {string} segment
 * @param {string[]} tokens
 * @returns {string | undefined}
 */
function gateFileWrite(segment, tokens) {
  const paths = tokens.map(normalisePath).filter(isGateFile);
  const redirects = [...segment.matchAll(/(?:^|[^<>&\d])>{1,2}\s*(["']?)([^\s"'&|;]+)\1/g)]
    .map((match) => normalisePath(match[2] ?? ''))
    .filter(isGateFile);
  if (redirects[0] !== undefined) {
    return redirects[0];
  }
  if (paths[0] === undefined) {
    return undefined;
  }
  const first = tokens[0] ?? '';
  const writes =
    (first === 'sed' &&
      tokens.some((token) => /^-[A-Za-z]*i/.test(token) || token.startsWith('--in-place'))) ||
    (first === 'perl' && tokens.some((token) => /^-[A-Za-z]*i/.test(token))) ||
    ['tee', 'mv', 'cp', 'rm', 'truncate', 'ln', 'install', 'dd', 'chmod'].includes(first) ||
    (first === 'git' &&
      ['checkout', 'restore', 'rm', 'mv', 'apply'].includes(gitArgs(tokens)[0] ?? '')) ||
    /writeFile|appendFile|createWriteStream|open\([^)]*['"][wa]/.test(segment);
  return writes ? paths[0] : undefined;
}

/**
 * @param {string} path
 * @returns {string}
 */
function normalisePath(path) {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^["']|["']$/g, '');
}

/**
 * Splits a command line on unquoted ;, &&, ||, | and newlines. Heredoc bodies stay in the segment
 * that opened them, which is what the write checks need.
 * @param {string} command
 * @returns {string[]}
 */
function segments(command) {
  /** @type {string[]} */
  const parts = [];
  let current = '';
  /** @type {string | undefined} */
  let quote;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (quote !== undefined) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (
      char === ';' ||
      char === '\n' ||
      char === '|' ||
      (char === '&' && command[index + 1] === '&')
    ) {
      if (char === '&' || (char === '|' && command[index + 1] === '|')) {
        index += 1;
      }
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * @param {string} segment
 * @returns {string[]}
 */
function tokenize(segment) {
  /** @type {string[]} */
  const tokens = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of segment.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * Drops leading VAR=value assignments and wrappers such as sudo, env and command.
 * @param {string[]} tokens
 * @returns {string[]}
 */
function withoutPrefix(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) ||
      ['sudo', 'env', 'command', 'exec', 'time'].includes(token)
    ) {
      index += 1;
    } else {
      break;
    }
  }
  return tokens.slice(index);
}

/**
 * Returns git's arguments from the subcommand on, skipping global options such as -C and -c.
 * @param {string[]} tokens tokens starting with "git"
 * @returns {string[]}
 */
function gitArgs(tokens) {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree') {
      index += 2;
    } else if (token.startsWith('-')) {
      index += 1;
    } else {
      break;
    }
  }
  return tokens.slice(index);
}

// ---------------------------------------------------------------------------------------------
// Edit / Write / MultiEdit
// ---------------------------------------------------------------------------------------------

/** Compiler options that must stay on in every tsconfig (and be present in the root one). */
const requiredCompilerFlags = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitOverride',
  'noImplicitReturns',
  'noFallthroughCasesInSwitch',
  'noUnusedLocals',
  'noUnusedParameters',
];

/** Text that must stay in eslint.config.mjs once it is there. */
const eslintMarkers = [
  'strictTypeChecked',
  'stylisticTypeChecked',
  'require-description',
  'no-unlimited-disable',
  'ban-ts-comment',
  'reportUnusedDisableDirectives',
  "name: 'vscode'",
  "'no-console': 'error'",
];

/** Text each npm script must keep. */
const scriptMarkers = {
  lint: ['eslint', '--max-warnings 0'],
  typecheck: ['tsc'],
  'format:check': ['prettier --check'],
  test: ['run-logged.mjs test', 'vitest'],
  'test:player': ['run-logged.mjs test:player', 'playwright test'],
  'test:smoke': ['run-logged.mjs test:smoke', 'run-smoke.mjs'],
  'verify:fast': ['format:check', 'lint', 'typecheck', 'npm run test'],
  verify: ['verify:fast', 'test:player', 'test:smoke', 'check-logs'],
};

/** Hook events .claude/settings.json must keep. */
const hookEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'];

/**
 * Checks an edit for loosened quality gates or skipped tests.
 * @param {string} relativePath path relative to the repository root, forward slashes
 * @param {string | undefined} before the file's content before the edit (undefined for a new file)
 * @param {string} after the file's content after the edit
 * @returns {string[]}
 */
export function checkEdit(relativePath, before, after) {
  /** @type {string[]} */
  const reasons = [];
  const name = relativePath.split('/').pop() ?? relativePath;

  if (/^tsconfig[^/]*\.json$/.test(name)) {
    const options = compilerOptions(after);
    for (const flag of requiredCompilerFlags) {
      const value = options?.[flag];
      if (value === false || (relativePath === 'tsconfig.json' && value !== true)) {
        reasons.push(`${relativePath}: compilerOptions.${flag} must stay true.`);
      }
    }
  }

  if (/^eslint\.config\.[cm]?[jt]s$/.test(name)) {
    for (const marker of eslintMarkers) {
      if (before?.includes(marker) === true && !after.includes(marker)) {
        reasons.push(`${relativePath}: "${marker}" was removed. Lint rules may only get stricter.`);
      }
    }
    const loose = (/** @type {string} */ text) =>
      (text.match(/['"](off|warn)['"]|:\s*[01]\s*[,}\]]/g) ?? []).length;
    if (before !== undefined && loose(after) > loose(before)) {
      reasons.push(
        `${relativePath}: a rule was turned off or down to "warn". Lint rules may only get stricter.`,
      );
    }
  }

  if (relativePath === 'package.json') {
    const scripts = scriptsOf(after);
    for (const [script, markers] of Object.entries(scriptMarkers)) {
      const body = scripts[script];
      if (body === undefined) {
        reasons.push(`package.json: the "${script}" script was removed.`);
        continue;
      }
      for (const marker of markers) {
        if (!body.includes(marker)) {
          reasons.push(`package.json: the "${script}" script must keep "${marker}".`);
        }
      }
    }
  }

  if (relativePath === '.claude/settings.json') {
    const parsed = safeParse(after);
    const hooks = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : {};
    for (const event of hookEvents) {
      if (!Array.isArray(hooks[event]) || hooks[event].length === 0) {
        reasons.push(`.claude/settings.json: the ${event} hook must stay.`);
      }
    }
  }

  if (/^\.husky\/pre-(commit|push)$/.test(relativePath) && before !== undefined) {
    for (const line of before.split('\n').filter((text) => text.trim() !== '')) {
      if (!after.includes(line)) {
        reasons.push(`${relativePath}: "${line.trim()}" was removed from the git hook.`);
      }
    }
  }

  if (
    relativePath === 'playwright.config.ts' &&
    before?.includes('forbidOnly: true') === true &&
    !after.includes('forbidOnly: true')
  ) {
    reasons.push('playwright.config.ts: forbidOnly: true must stay.');
  }

  if (relativePath === 'scripts/check-logs.mjs' && before !== undefined) {
    for (const kind of before.matchAll(/kind: '([^']+)'/g)) {
      if (!after.includes(`kind: '${kind[1] ?? ''}'`)) {
        reasons.push(
          `scripts/check-logs.mjs: the "${kind[1] ?? ''}" rule was removed. Allowlist noise with a reason instead.`,
        );
      }
    }
  }

  if (relativePath.startsWith('test/')) {
    const skips = (/** @type {string} */ text) =>
      (
        text.match(
          /\b(it|test|describe|suite)\.(skip|only|todo|fixme|skipIf|runIf)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\(/g,
        ) ?? []
      ).length;
    if (skips(after) > skips(before ?? '')) {
      reasons.push(
        `${relativePath}: tests may not be skipped, focused or left as todo. Fix the test or the code.`,
      );
    }
  }

  return reasons;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
function compilerOptions(text) {
  const parsed = safeParse(text);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const options = parsed.compilerOptions;
  return isRecord(options) ? options : {};
}

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
function scriptsOf(text) {
  const parsed = safeParse(text);
  const scripts = isRecord(parsed) ? parsed.scripts : undefined;
  /** @type {Record<string, string>} */
  const result = {};
  if (isRecord(scripts)) {
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function safeParse(text) {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}
