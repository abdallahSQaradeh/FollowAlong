// @ts-check
/**
 * Regenerates the small media fixtures in test/fixtures/media/ with ffmpeg (spec #12, Testing
 * Decisions: "small generated media fixtures (a few seconds each)"). The outputs are committed,
 * so tests never need ffmpeg; run this only to change a fixture: node scripts/make-media-fixtures.mjs
 *
 * lesson.webm: 3 s, 320x180, VP8 video (a test pattern) + Vorbis sound (a 440 Hz tone), the
 * codecs of every real WebM Lesson measured in research 01.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const media = join(root, 'test', 'fixtures', 'media');
mkdirSync(media, { recursive: true });

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const output = join(media, 'lesson.webm');
const result = spawnSync(
  ffmpeg,
  [
    ['-y', '-hide_banner', '-loglevel', 'error'],
    ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=3'],
    ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3'],
    ['-c:v', 'libvpx', '-b:v', '200k', '-g', '25'],
    ['-c:a', 'libvorbis', '-q:a', '2'],
    ['-map_metadata', '-1', '-fflags', '+bitexact', '-shortest', output],
  ].flat(),
  { stdio: 'inherit' },
);
if (result.status !== 0) {
  console.error(`make-media-fixtures: ${ffmpeg} failed (status ${String(result.status)}).`);
  process.exit(1);
}
console.log(`make-media-fixtures: wrote ${output}`);
