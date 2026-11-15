// @ts-check
/**
 * Runs a command, prints its output as usual, and also writes its full stdout and stderr to
 * .logs/<script>-<timestamp>.log so scripts/check-logs.mjs can scan it afterwards.
 *
 * Usage: node scripts/run-logged.mjs <script-name> -- <command> [args...]
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson } from './lib/json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logsDir = join(root, '.logs');
const keepPerScript = 10;

const separator = process.argv.indexOf('--');
const scriptName = process.argv[2];
const [command, ...args] = separator === -1 ? [] : process.argv.slice(separator + 1);
if (scriptName === undefined || scriptName === '--' || command === undefined) {
  console.error('Usage: node scripts/run-logged.mjs <script-name> -- <command> [args...]');
  process.exit(2);
}

/** A file-name-safe form of an npm script name: "test:player" becomes "test-player". */
const slug = scriptName.replace(/[^A-Za-z0-9_-]+/g, '-');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(logsDir, { recursive: true });
pruneOldLogs(slug);
const logPath = join(logsDir, `${slug}-${stamp}.log`);
const log = createWriteStream(logPath);

const [executable, executableArgs] = resolveCommand(command, args);
log.write(`$ ${[command, ...args].join(' ')}\n# started ${new Date().toISOString()}\n\n`);

const env = { ...process.env };
if (process.stdout.isTTY && env.NO_COLOR === undefined) {
  env.FORCE_COLOR = '1';
}
const started = Date.now();
const child = spawn(executable, executableArgs, {
  cwd: root,
  env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});
child.on('error', (error) => {
  log.write(`\n# could not start ${command}: ${error.message}\n`);
  console.error(`run-logged: could not start ${command}: ${error.message}`);
});
child.on('close', (code, signal) => {
  const exitCode = code ?? 1;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log.write(`\n# exit ${String(code)}${signal ? ` (signal ${signal})` : ''} after ${seconds}s\n`);
  log.end(() => {
    console.log(`\nFull log: ${relative(root, logPath)}`);
    process.exit(exitCode);
  });
});

/**
 * Runs `node` as this Node, and a package binary through its JavaScript entry point, so no shell
 * (and no Windows .cmd shim) is involved and arguments are passed through unchanged.
 * @param {string} name
 * @param {string[]} rest
 * @returns {[string, string[]]}
 */
function resolveCommand(name, rest) {
  if (name === 'node') {
    return [process.execPath, rest];
  }
  const entry = findBinEntry(name);
  if (entry === undefined) {
    console.error(`run-logged: no package in node_modules provides the "${name}" binary.`);
    process.exit(2);
  }
  return [process.execPath, [entry, ...rest]];
}

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function findBinEntry(name) {
  const modules = join(root, 'node_modules');
  /** @type {string[]} */
  const candidates = [join(modules, name)];
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(modules, entry))) {
        candidates.push(join(modules, entry, scoped));
      }
    } else if (entry !== name) {
      candidates.push(join(modules, entry));
    }
  }
  for (const dir of candidates) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) {
      continue;
    }
    const pkg = /** @type {{ name?: string, bin?: string | Record<string, string> }} */ (
      readJson(manifest)
    );
    if (typeof pkg.bin === 'string' && pkg.name === name) {
      return join(dir, pkg.bin);
    }
    if (typeof pkg.bin === 'object' && typeof pkg.bin[name] === 'string') {
      return join(dir, pkg.bin[name]);
    }
  }
  return undefined;
}

/**
 * Keeps the newest few logs of a script so .logs/ does not grow without bound.
 * @param {string} prefix
 */
function pruneOldLogs(prefix) {
  const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.log$`);
  const logs = readdirSync(logsDir)
    .filter((file) => pattern.test(file))
    .sort();
  for (const file of logs.slice(0, Math.max(0, logs.length - (keepPerScript - 1)))) {
    rmSync(join(logsDir, file), { force: true });
  }
}
