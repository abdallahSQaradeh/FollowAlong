// @ts-check
/**
 * Regenerates the small media fixtures in test/fixtures/media/ with ffmpeg (spec #12, Testing
 * Decisions: "small generated media fixtures (a few seconds each)"). The outputs are committed,
 * so tests never need ffmpeg; run this only to change a fixture: node scripts/make-media-fixtures.mjs
 *
 * The WebM files are VP8 video (a test pattern) + Vorbis sound (a 440 Hz tone), the codecs of every
 * real WebM Lesson measured in research 01:
 * - lesson.webm: 3 s, 320x180;
 * - long.webm: 8 s, 160x90, a Cluster every second, so the seek tests have media to evict and
 *   Clusters to re-stream from.
 * The MP4 is H.264 + AAC, the codecs of every real MP4 Lesson (research 01):
 * - sample.mp4: 3 s, 320x180, with its index at the start (faststart). Its name sorts after the
 *   WebM files, so the first Lesson of this folder (the smoke test's Course) stays lesson.webm.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const media = join(root, 'test', 'fixtures', 'media');
mkdirSync(media, { recursive: true });

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';

/**
 * @param {string} name
 * @param {{ seconds: number, size: string, video: string[], audio: string[], extra: string[] }} options
 */
function make(name, options) {
  const output = join(media, name);
  const result = spawnSync(
    ffmpeg,
    [
      ['-y', '-hide_banner', '-loglevel', 'error'],
      [
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${options.size}:rate=25:duration=${String(options.seconds)}`,
      ],
      [
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=44100:duration=${String(options.seconds)}`,
      ],
      options.video,
      options.audio,
      options.extra,
      ['-map_metadata', '-1', '-fflags', '+bitexact', '-shortest', output],
    ].flat(),
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`make-media-fixtures: ${ffmpeg} failed (status ${String(result.status)}).`);
    process.exit(1);
  }
  console.log(`make-media-fixtures: wrote ${output}`);
}

const vp8 = (/** @type {string} */ bitrate) => ['-c:v', 'libvpx', '-b:v', bitrate, '-g', '25'];
const vorbis = ['-c:a', 'libvorbis', '-q:a', '2'];

make('lesson.webm', { seconds: 3, size: '320x180', video: vp8('200k'), audio: vorbis, extra: [] });
make('long.webm', {
  seconds: 8,
  size: '160x90',
  video: vp8('60k'),
  audio: vorbis,
  extra: ['-cluster_time_limit', '1000'],
});
make('sample.mp4', {
  seconds: 3,
  size: '320x180',
  video: ['-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '25'],
  audio: ['-c:a', 'aac', '-b:a', '64k'],
  extra: ['-movflags', '+faststart'],
});
