// @ts-check
/**
 * Checks the ffmpeg.exe that goes into the .vsix (ADR 0070), by running it: it must be an LGPL
 * build (no `--enable-gpl`, `--enable-nonfree` or `--enable-version3`), have the AAC decoder and the
 * MP3 encoder, and turn the sound of a real MP4 into a real MP3 with the arguments the audio
 * sidecar uses (`soundArguments` in src/adapters/node/converter.ts). CI runs it on Windows against
 * the artifact of the build job; its output is the evidence of what ships.
 *
 * Usage: node scripts/check-bundled-ffmpeg.mjs [<ffmpeg.exe>] [--wrapper <program>]
 *   <ffmpeg.exe>  default bin/ffmpeg.exe
 *   --wrapper     a program that runs it, for a machine that is not Windows (wine)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const wrapperAt = argv.indexOf('--wrapper');
const wrapper = wrapperAt >= 0 ? argv[wrapperAt + 1] : undefined;
const positional = argv.filter((_, index) => index !== wrapperAt && index !== wrapperAt + 1);
const ffmpeg = resolve(positional[0] ?? join(root, 'bin', 'ffmpeg.exe'));
const input = join(root, 'test', 'fixtures', 'media', 'sidecar.mp4');

/**
 * What ffmpeg printed, both streams, and its exit code.
 * @param {string[]} args
 */
function ffmpegRun(args) {
  const result = spawnSync(
    wrapper ?? ffmpeg,
    [...(wrapper === undefined ? [] : [ffmpeg]), ...args],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
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

const version = ffmpegRun(['-hide_banner', '-version']);
console.log(version.text);
const buildconf = ffmpegRun(['-hide_banner', '-buildconf']);
console.log(buildconf.text);
check(version.code === 0, 'ffmpeg -version runs');
check(/^ffmpeg version 7\.1\.1\b/m.test(version.text), 'it is ffmpeg 7.1.1');
check(
  !/--enable-(gpl|nonfree|version3)/.test(version.text + buildconf.text),
  'configured without --enable-gpl, --enable-nonfree and --enable-version3',
);
check(buildconf.text.includes('--enable-libmp3lame'), 'configured with --enable-libmp3lame');
check(!/GNU General Public License/i.test(version.text), 'not licensed under the GPL');
check(
  /^\s*A\S* +aac\b/m.test(ffmpegRun(['-hide_banner', '-decoders']).text),
  'has the AAC decoder',
);
check(
  /^\s*A\S* +libmp3lame\b/m.test(ffmpegRun(['-hide_banner', '-encoders']).text),
  'has the MP3 encoder (libmp3lame)',
);

// What the converter does (src/adapters/node/converter.ts): probe, then extract.
const probe = ffmpegRun(['-hide_banner', '-nostdin', '-i', input]);
check(/^Input #0/m.test(probe.text), 'reads an MP4 Lesson (the probe)');
check(/Stream #\d+:\d+\S*: Audio: aac\b/m.test(probe.text), 'the probe finds the AAC sound');
const folder = mkdtempSync(join(tmpdir(), 'followalong-ffmpeg-check-'));
try {
  const output = join(folder, 'sidecar.mp3');
  const extract = ffmpegRun([
    ...['-hide_banner', '-nostdin', '-y', '-i', input],
    ...['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '4', '-map_metadata', '-1'],
    ...['-f', 'mp3', output],
  ]);
  check(extract.code === 0, `converts the sound to MP3 (exit ${String(extract.code)})`);
  const mp3 = readFileSync(output);
  // An MP3 starts with an ID3 tag, or straight with a frame header (sync bits 0xFFE).
  const isMp3 =
    mp3.subarray(0, 3).toString('latin1') === 'ID3' ||
    ((mp3[0] ?? 0) === 0xff && ((mp3[1] ?? 0) & 0xe0) === 0xe0);
  check(mp3.length > 1000 && isMp3, `the output is an MP3 (${String(mp3.length)} bytes)`);
  const reread = ffmpegRun(['-hide_banner', '-nostdin', '-i', output]);
  check(/Audio: mp3\b/.test(reread.text), 'the output reads back as MP3 sound');
} finally {
  rmSync(folder, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nThe bundled ffmpeg is an LGPL build that converts AAC sound to MP3.');
}
