// @ts-check
/**
 * Builds the minimal LGPL ffmpeg.exe the Windows x64 .vsix ships (spec #12, Further Notes;
 * ADR 0070): ffmpeg and LAME are cross-compiled on Linux with mingw-w64, from the pinned source
 * tarballs of `scripts/bundled-ffmpeg.json`, each checked against its SHA-256. Only what the
 * audio sidecar needs is built: the MP4 and WebM demuxers, the AAC decoder, the MP3 encoder (LAME),
 * the MP3 muxer and the file protocol. Never `--enable-gpl` or `--enable-nonfree`.
 *
 * Usage: node scripts/build-ffmpeg.mjs [--out <folder>] [--work <folder>]
 *   --out   where ffmpeg.exe and its notices go (default: bin/ in the repository, git-ignored)
 *   --work  where sources are downloaded and built (default: a folder in the system temp dir)
 * Needs on PATH: x86_64-w64-mingw32-gcc, make, nasm, tar. Runs commands with argument arrays and
 * never through a shell.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {object} Source
 * @property {string} version
 * @property {string} archive
 * @property {string} directory
 * @property {string} sha256
 * @property {string[]} urls
 * @property {string} licenseFile
 * @property {string[]} configure
 */

/** @type {unknown} */
const pinnedJson = JSON.parse(readFileSync(join(root, 'scripts', 'bundled-ffmpeg.json'), 'utf8'));
const pinned = /** @type {{ target: string, ffmpeg: Source, lame: Source }} */ (pinnedJson);

/** The Windows system libraries the built ffmpeg.exe may import, and no others. */
const systemLibraries = new Set([
  'advapi32.dll',
  'bcrypt.dll',
  'kernel32.dll',
  'msvcrt.dll',
  'shell32.dll',
  'user32.dll',
  'ws2_32.dll',
]);

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd?: string, capture?: boolean }} [options]
 * @returns {string} what the command printed, when it is captured
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 3).join(' ')} failed (${result.error?.message ?? `exit ${String(result.status)}`})`,
    );
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Downloads `source` from the first of its URLs that serves bytes with the pinned SHA-256.
 * @param {Source} source
 * @param {string} folder
 * @returns {Promise<string>} the archive's path
 */
async function download(source, folder) {
  const path = join(folder, source.archive);
  if (existsSync(path) && sha256(readFileSync(path)) === source.sha256) {
    return path;
  }
  /** @type {string[]} */
  const failures = [];
  for (const url of source.urls) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${String(response.status)}`);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== source.sha256) {
        failures.push(`${url}: SHA-256 is ${actual}, not the pinned ${source.sha256}`);
        continue;
      }
      writeFileSync(path, bytes);
      console.log(`Downloaded ${source.archive} from ${url} (SHA-256 ${actual})`);
      return path;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not get ${source.archive}:\n  ${failures.join('\n  ')}`);
}

/**
 * @param {Source} source
 * @param {string} work
 * @returns {Promise<string>} the folder of the unpacked sources
 */
async function fetchSources(source, work) {
  const archive = await download(source, work);
  const folder = join(work, source.directory);
  rmSync(folder, { recursive: true, force: true });
  run('tar', ['-xf', archive, '-C', work]);
  return folder;
}

/** @param {string} program */
function requireTool(program) {
  const result = spawnSync(program, ['--version'], { stdio: 'ignore' });
  if (result.error !== undefined) {
    throw new Error(
      `${program} is not installed. On Ubuntu: sudo apt-get install gcc-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64 make nasm xz-utils`,
    );
  }
}

/**
 * The names of the DLLs `exe` imports, lowercased.
 * @param {string} exe
 */
function importedLibraries(exe) {
  const listing = run(`${pinned.target}-objdump`, ['-p', exe], { capture: true });
  return [...listing.matchAll(/DLL Name: (\S+)/g)].map((match) => (match[1] ?? '').toLowerCase());
}

/**
 * @param {string} config the config.h of the built ffmpeg
 * @param {string} name
 */
function configValue(config, name) {
  return new RegExp(`^#define ${name} (.*)$`, 'm').exec(config)?.[1];
}

/**
 * The value after `name` in `argv`, as a full path, or `fallback`.
 * @param {string[]} argv
 * @param {string} name
 * @param {string} fallback
 */
function option(argv, name, fallback) {
  const at = argv.indexOf(name);
  return at >= 0 ? resolve(argv[at + 1] ?? fallback) : fallback;
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('The ffmpeg is cross-compiled on Linux (CI builds it on ubuntu-latest).');
  }
  const out = option(process.argv, '--out', join(root, 'bin'));
  const work = option(process.argv, '--work', join(tmpdir(), 'followalong-ffmpeg-build'));
  const prefix = join(work, 'prefix');
  const target = pinned.target;
  for (const tool of [`${target}-gcc`, `${target}-objdump`, `${target}-strip`, 'make', 'nasm']) {
    requireTool(tool);
  }
  mkdirSync(work, { recursive: true });
  mkdirSync(out, { recursive: true });

  const lameSource = await fetchSources(pinned.lame, work);
  const ffmpegSource = await fetchSources(pinned.ffmpeg, work);
  const jobs = String(Math.max(1, Number(process.env.BUILD_JOBS ?? '4')));

  console.log(`\n== LAME ${pinned.lame.version} (static, LGPL)`);
  run(
    join(lameSource, 'configure'),
    [`--host=${target}`, `--prefix=${prefix}`, ...pinned.lame.configure],
    { cwd: lameSource },
  );
  run('make', ['-j', jobs], { cwd: lameSource });
  run('make', ['install'], { cwd: lameSource });

  console.log(`\n== ffmpeg ${pinned.ffmpeg.version} (LGPL, minimal)`);
  run(
    join(ffmpegSource, 'configure'),
    [
      `--cross-prefix=${target}-`,
      `--extra-cflags=-I${join(prefix, 'include')}`,
      `--extra-ldflags=-L${join(prefix, 'lib')} -static`,
      ...pinned.ffmpeg.configure,
    ],
    { cwd: ffmpegSource },
  );
  run('make', ['-j', jobs], { cwd: ffmpegSource });

  const built = join(ffmpegSource, 'ffmpeg.exe');
  run(`${target}-strip`, [built]);

  // The build must be LGPL: no GPL or non-free component, and no library but Windows' own.
  const config = readFileSync(join(ffmpegSource, 'config.h'), 'utf8');
  const configuration = (configValue(config, 'FFMPEG_CONFIGURATION') ?? '').replace(/\\"/g, '"');
  // ffmpeg's own name for its licence: "LGPL version 2.1 or later" (GPL and nonfree builds say so).
  const license = (configValue(config, 'FFMPEG_LICENSE') ?? '').replaceAll('"', '');
  const flags = readFileSync(join(ffmpegSource, 'ffbuild', 'config.mak'), 'utf8');
  if (
    /--enable-(gpl|nonfree|version3)/.test(configuration) ||
    /^CONFIG_GPL=yes/m.test(flags) ||
    license !== 'LGPL version 2.1 or later'
  ) {
    throw new Error(`The build is not LGPL: ${license} / ${configuration}`);
  }
  const libraries = importedLibraries(built);
  const unexpected = libraries.filter((name) => !systemLibraries.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `ffmpeg.exe imports libraries that do not ship with Windows: ${unexpected.join(', ')}`,
    );
  }

  copyFileSync(built, join(out, 'ffmpeg.exe'));
  copyFileSync(
    join(ffmpegSource, pinned.ffmpeg.licenseFile),
    join(out, 'FFMPEG-LICENSE-LGPL-2.1.txt'),
  );
  copyFileSync(join(lameSource, pinned.lame.licenseFile), join(out, 'LAME-LICENSE-LGPL.txt'));
  writeFileSync(
    join(out, 'FFMPEG-BUILD.txt'),
    [
      'The ffmpeg.exe in this folder, how it was built, and where its source is.',
      '',
      `ffmpeg ${pinned.ffmpeg.version}, ${license}`,
      `  source: ${pinned.ffmpeg.urls.join('\n          ')}`,
      `  SHA-256: ${pinned.ffmpeg.sha256}`,
      `LAME ${pinned.lame.version}, statically linked (LGPL)`,
      `  source: ${pinned.lame.urls.join('\n          ')}`,
      `  SHA-256: ${pinned.lame.sha256}`,
      '',
      `Cross-compiled for ${target} with mingw-w64 by scripts/build-ffmpeg.mjs, from the sources above.`,
      '',
      'ffmpeg configure options (scripts/bundled-ffmpeg.json):',
      ...pinned.ffmpeg.configure.map((flag) => `  ${flag}`),
      'LAME configure options:',
      ...pinned.lame.configure.map((flag) => `  ${flag}`),
      '',
      'Configuration as ffmpeg reports it:',
      `  ${configuration}`,
      '',
      `Libraries ffmpeg.exe imports (all part of Windows): ${libraries.join(', ')}`,
      '',
    ].join('\n'),
  );
  console.log(
    `\nBuilt ${join(out, 'ffmpeg.exe')} (${String(Math.round(statSync(built).size / 1024))} KiB)`,
  );
  console.log(`license: ${license}\nconfiguration: ${configuration}`);
  console.log(`imports: ${libraries.join(', ')}`);
}

await main();
