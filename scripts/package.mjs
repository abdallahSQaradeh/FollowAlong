// @ts-check
/**
 * Packages FollowAlong as a private .vsix for Windows x64 (spec #12, Storage and packaging;
 * ADR 0004): a production build, then @vscode/vsce with the files listed in package.json "files".
 * The bundles hold every dependency, so node_modules is not packaged.
 *
 * Usage: npm run package   → followalong-win32-x64-<version>.vsix in the repository root
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVSIX } from '@vscode/vsce';

import { build } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What `scripts/build-ffmpeg.mjs` leaves in bin/ (ADR 0070): the ffmpeg and the notices that must
 * travel with it. The .vsix is never made without them, so it can never ship the program with no
 * licence, or a Lesson with no sound.
 */
/** @type {unknown} */
const pinnedJson = JSON.parse(readFileSync(join(root, 'scripts', 'bundled-ffmpeg.json'), 'utf8'));
const bundledFfmpegFiles = /** @type {{ outputs: string[] }} */ (pinnedJson).outputs;
const missing = bundledFfmpegFiles.filter((name) => !existsSync(join(root, 'bin', name)));
if (missing.length > 0) {
  throw new Error(
    `bin/ lacks ${missing.join(', ')}. Build the bundled ffmpeg first: node scripts/build-ffmpeg.mjs (Linux with mingw-w64), or npm run fetch-ffmpeg (downloads it from CI).`,
  );
}

await build({ production: true });
await createVSIX({
  cwd: root,
  target: 'win32-x64',
  dependencies: false,
  // Private and UNLICENSED: there is no LICENSE file for FollowAlong itself. The licences of what
  // it ships are in THIRD_PARTY_NOTICES.txt and bin/.
  skipLicense: true,
});
