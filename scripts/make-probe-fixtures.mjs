// @ts-check
/**
 * Regenerates the recorded ffmpeg output in test/fixtures/probe/ (spec #12, Testing Decisions; ticket
 * #42): what `ffmpeg -i <Lesson>` and a sound conversion write to their error output, which the
 * Converter adapter reads to learn a Lesson's sound codec and the progress of a conversion. The tests
 * replay these files in place of the ffmpeg process, so they never need ffmpeg.
 * Run this only to change them: node scripts/make-probe-fixtures.mjs (FFMPEG=<path> for another ffmpeg).
 *
 * Each probe file comes from a real ffmpeg run over a 1 s clip made here:
 * - aac.txt: H.264 + AAC, the sound of every real MP4 Lesson;
 * - mp3.txt: H.264 + MP3, a sound the page decodes in an MP4 itself;
 * - silent.txt: H.264 only;
 * - two-tracks.txt: H.264, then MP3 and AAC sound tracks, in that order: the first one counts;
 * - unreadable.txt: a text file with an .mp4 name;
 * - no-duration.txt: test/fixtures/media/no-duration.webm, a WebM whose length ffmpeg reports as
 *   `Duration: N/A` (made by scripts/make-media-fixtures.mjs).
 * convert-aac.txt is the output of converting an AAC Lesson's sound as the converter does it.
 * The clip's path is written as `/lesson/<name>` so the files do not depend on where they were made.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures', 'probe');
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const work = mkdtempSync(join(tmpdir(), 'followalong-probe-'));

/**
 * @param {string[]} args
 * @returns {string} what ffmpeg wrote to its error output
 */
function run(args) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (result.error !== undefined) {
    console.error(`make-probe-fixtures: could not run ${ffmpeg}: ${result.error.message}`);
    process.exit(1);
  }
  return result.stderr;
}

const video = ['-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10:duration=1'];
const tone = (/** @type {number} */ hertz) => [
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=${String(hertz)}:sample_rate=44100:duration=1`,
];
const h264 = ['-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p'];

/**
 * @param {string} name
 * @param {string[]} args the ffmpeg arguments that write the clip, ending with its file name
 */
function clip(name, args) {
  const file = join(work, name);
  const stderr = run(['-y', '-hide_banner', '-loglevel', 'error', ...args, file]);
  if (stderr.trim() !== '') {
    console.error(`make-probe-fixtures: ${name}: ${stderr}`);
    process.exit(1);
  }
  return file;
}

/**
 * @param {string} name
 * @param {string} text
 */
function record(name, text) {
  const normalised = text.replaceAll(work, '/lesson').replaceAll('\\', '/');
  writeFileSync(join(out, name), normalised);
  console.log(`make-probe-fixtures: wrote ${join(out, name)}`);
}

/** @param {string} file */
function probe(file) {
  return run(['-hide_banner', '-nostdin', '-i', file]);
}

const aac = clip('aac.mp4', [...video, ...tone(440), ...h264, '-c:a', 'aac', '-shortest']);
const mp3 = clip('mp3.mp4', [...video, ...tone(440), ...h264, '-c:a', 'libmp3lame', '-shortest']);
const silent = clip('silent.mp4', [...video, ...h264, '-an']);
const two = clip('two-tracks.mp4', [
  ...video,
  ...tone(440),
  ...tone(880),
  ...h264,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:a',
  '-c:a:0',
  'libmp3lame',
  '-c:a:1',
  'aac',
  '-shortest',
]);
const unreadable = join(work, 'unreadable.mp4');
writeFileSync(unreadable, 'this is not a video');
const noDuration = join(work, 'no-duration.webm');
copyFileSync(join(root, 'test', 'fixtures', 'media', 'no-duration.webm'), noDuration);

record('aac.txt', probe(aac));
record('mp3.txt', probe(mp3));
record('silent.txt', probe(silent));
record('two-tracks.txt', probe(two));
record('unreadable.txt', probe(unreadable));
record('no-duration.txt', probe(noDuration));
record(
  'convert-aac.txt',
  run([
    ...['-hide_banner', '-nostdin', '-y', '-i', aac],
    ...['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '4', '-map_metadata', '-1'],
    ...['-f', 'mp3', join(work, 'out.mp3')],
  ]),
);
rmSync(work, { recursive: true, force: true });
