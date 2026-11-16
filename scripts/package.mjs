// @ts-check
/**
 * Packages FollowAlong as a private .vsix for Windows x64 (spec #12, Storage and packaging;
 * ADR 0004): a production build, then @vscode/vsce with the files listed in package.json "files".
 * The bundles hold every dependency, so node_modules is not packaged.
 *
 * Usage: npm run package   → followalong-win32-x64-<version>.vsix in the repository root
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVSIX } from '@vscode/vsce';

import { build } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({ production: true });
await createVSIX({
  cwd: root,
  target: 'win32-x64',
  dependencies: false,
  // Private and UNLICENSED: there is no LICENSE file to ship. The bundled ffmpeg's LGPL notice
  // arrives with the ticket that bundles it.
  skipLicense: true,
});
