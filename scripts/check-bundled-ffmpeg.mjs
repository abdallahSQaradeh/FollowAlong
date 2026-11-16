// @ts-check
/**
 * Checks the ffmpeg.exe that goes into the .vsix (ADR 0070), by running it: it must be ffmpeg
 * 7.1.1 under the LGPL (no `--enable-gpl`, `--enable-nonfree` or `--enable-version3`), have the AAC
 * decoder and the MP3 encoder, and, run by the extension's own converter adapter
 * (src/adapters/node/converter.ts, bundled here with esbuild), read the AAC sound of a real MP4 and
 * turn it into a real MP3. CI runs it on Windows against the ffmpeg.exe unpacked from the packaged
 * .vsix, so it proves the file that ships; its output is the evidence of what ships.
 *
 * Usage: node scripts/check-bundled-ffmpeg.mjs [<ffmpeg.exe>] [--run <program>]
 *   <ffmpeg.exe>  default bin/ffmpeg.exe
 *   --run         a program that stands in for ffmpeg.exe where it cannot run itself (a script that
 *                 starts it under wine, on Linux); it gets ffmpeg's arguments
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const runAt = argv.indexOf('--run');
const positional = argv.filter((_, index) => index !== runAt && index !== runAt + 1);
const exe = resolve(positional[0] ?? join(root, 'bin', 'ffmpeg.exe'));
const program = runAt >= 0 ? resolve(argv[runAt + 1] ?? exe) : exe;
const input = join(root, 'test', 'fixtures', 'media', 'sidecar.mp4');
/** @type {unknown} */
const pinnedJson = JSON.parse(readFileSync(join(root, 'scripts', 'bundled-ffmpeg.json'), 'utf8'));
const pinned = /** @type {{ ffmpeg: { version: string } }} */ (pinnedJson);

/**
 * What ffmpeg printed, both streams, and its exit code.
 * @param {string[]} args
 */
function ffmpegRun(args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { text: `${result.stdout}\n${result.stderr}`, code: result.status };
}

/** @type {string[]} */
const problems = [];
/**
 * @param {boolean} ok
 * @param {string} what
 */
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    problems.push(what);
  }
}

console.log(`Checking ${exe}${program === exe ? '' : ` (run as ${program})`}\n`);
const version = ffmpegRun(['-hide_banner', '-version']);
console.log(version.text);
const buildconf = ffmpegRun(['-hide_banner', '-buildconf']);
console.log(buildconf.text);
const licence = ffmpegRun(['-hide_banner', '-L']);
console.log(licence.text);
check(version.code === 0, 'ffmpeg -version runs');
check(
  new RegExp(`^ffmpeg version ${pinned.ffmpeg.version.replaceAll('.', '\\.')}\\b`, 'm').test(
    version.text,
  ),
  `it is ffmpeg ${pinned.ffmpeg.version} (scripts/bundled-ffmpeg.json)`,
);
check(
  /GNU Lesser General Public\s+License/.test(licence.text) &&
    !/GNU General Public\s+License/.test(licence.text),
  'its licence (ffmpeg -L) is the GNU Lesser General Public License, not the GPL',
);
check(/version\s+2\.1 of the License, or/.test(licence.text), 'LGPL version 2.1 or later');
check(
  !/--enable-(gpl|nonfree|version3)/.test(version.text + buildconf.text),
  'configured without --enable-gpl, --enable-nonfree and --enable-version3',
);
check(buildconf.text.includes('--enable-libmp3lame'), 'configured with --enable-libmp3lame');
check(
  /^\s*A\S* +aac\b/m.test(ffmpegRun(['-hide_banner', '-decoders']).text),
  'has the AAC decoder',
);
check(
  /^\s*A\S* +libmp3lame\b/m.test(ffmpegRun(['-hide_banner', '-encoders']).text),
  'has the MP3 encoder (libmp3lame)',
);

// What the extension does: its converter adapter probes the Lesson, then extracts the sound.
const folder = mkdtempSync(join(tmpdir(), 'followalong-ffmpeg-check-'));
try {
  const bundle = await esbuild.build({
    entryPoints: [join(root, 'src', 'adapters', 'node', 'converter.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'warning',
  });
  const adapter = join(folder, 'converter.mjs');
  writeFileSync(adapter, bundle.outputFiles[0]?.text ?? '');
  /** @type {unknown} */
  const loaded = await import(pathToFileURL(adapter).href);
  const { createFfmpegConverter } =
    /** @type {{ createFfmpegConverter: () => import('../src/core/ports.js').Converter }} */ (
      loaded
    );
  const converter = createFfmpegConverter();
  const signal = new AbortController().signal;

  const codec = await converter.soundCodec({ program, input, signal });
  check(codec === 'aac', `the adapter's probe finds the sound of the MP4 Lesson: ${String(codec)}`);

  const output = join(folder, 'sidecar.mp3');
  /** @type {number[]} */
  const percents = [];
  await converter.extractSound({
    program,
    input,
    output,
    signal,
    onProgress: (percent) => percents.push(percent),
  });
  check(
    percents.at(-1) === 100,
    `the adapter converts it, reporting up to ${String(percents.at(-1))}%`,
  );
  const mp3 = readFileSync(output);
  // The file starts with an ID3v2 tag (its size in four 7-bit bytes), or straight with a frame.
  const tag =
    mp3.subarray(0, 3).toString('latin1') === 'ID3'
      ? 10 +
        (((mp3[6] ?? 0) & 0x7f) << 21) +
        (((mp3[7] ?? 0) & 0x7f) << 14) +
        (((mp3[8] ?? 0) & 0x7f) << 7) +
        ((mp3[9] ?? 0) & 0x7f)
      : 0;
  // A frame header: 11 sync bits, then MPEG version (not reserved) and layer III ("01").
  const first = mp3[tag] ?? 0;
  const second = mp3[tag + 1] ?? 0;
  const layer3 = first === 0xff && (second & 0xe0) === 0xe0 && (second & 0x06) === 0x02;
  check(
    mp3.length > 1000 && layer3,
    `the output is an MP3 file: layer III frames (${String(mp3.length)} bytes)`,
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nThe bundled ffmpeg is an LGPL build that converts AAC sound to MP3.');
}
