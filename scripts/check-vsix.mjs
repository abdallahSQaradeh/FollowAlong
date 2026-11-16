// @ts-check
/**
 * Unpacks the .vsix that `npm run package` wrote and checks that it holds the bundled ffmpeg.exe,
 * its licences and build record, the build script and settings that make up the source offer, and
 * the notices (ADR 0070). A .vsix is a zip: on Windows this uses the system's `tar.exe` (bsdtar,
 * which reads zips; the `tar` of Git Bash does not), elsewhere `unzip`.
 *
 * Usage: node scripts/check-vsix.mjs [<folder to unpack into>]   (default: vsix-unpacked/)
 * Then: node scripts/check-bundled-ffmpeg.mjs vsix-unpacked/extension/bin/ffmpeg.exe
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const into = resolve(process.argv[2] ?? join(root, 'vsix-unpacked'));
/** @type {unknown} */
const pinnedJson = JSON.parse(readFileSync(join(root, 'scripts', 'bundled-ffmpeg.json'), 'utf8'));

const vsixFiles = readdirSync(root).filter((name) => name.endsWith('.vsix'));
const [vsix] = vsixFiles;
if (vsixFiles.length !== 1 || vsix === undefined) {
  throw new Error(`Expected one .vsix in the repository root, found ${String(vsixFiles.length)}.`);
}

rmSync(into, { recursive: true, force: true });
const windows = process.platform === 'win32';
const command = windows
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'unzip';
// tar.exe needs the folder to exist; unzip makes it.
mkdirSync(into, { recursive: true });
const unpacked = spawnSync(
  command,
  windows ? ['-xf', vsix, '-C', into] : ['-q', vsix, '-d', into],
  { stdio: 'inherit' },
);
if (unpacked.status !== 0) {
  throw new Error(`Could not unpack ${vsix} (${command} exit ${String(unpacked.status)}).`);
}

const outputs = /** @type {{ outputs: string[] }} */ (pinnedJson).outputs;
const expected = [
  ...outputs.map((name) => `bin/${name}`),
  'scripts/build-ffmpeg.mjs',
  'scripts/bundled-ffmpeg.json',
  'THIRD_PARTY_NOTICES.txt',
  'out/extension.js',
];
const missing = expected.filter((name) => !existsSync(join(into, 'extension', name)));
for (const name of expected) {
  console.log(`${missing.includes(name) ? 'FAIL' : 'ok  '} extension/${name}`);
}
if (missing.length > 0) {
  throw new Error(`The .vsix lacks: ${missing.join(', ')}`);
}
