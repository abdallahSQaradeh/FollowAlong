// @ts-check
/**
 * Builds the extension with esbuild (ADR 0004):
 * - out/extension.js: the extension host bundle (CommonJS, Node), with `vscode` left external;
 * - out/player/player.js and out/player/player.css: the webview script (an IIFE for the browser)
 *   and stylesheet, which the extension inlines into the player page.
 *
 * Usage: node scripts/build.mjs [--production]   (--production minifies and drops source maps)
 * Other scripts import build() to build before they run.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');

/**
 * @param {{ production?: boolean }} [options]
 */
export async function build(options = {}) {
  const production = options.production === true;
  /** @type {esbuild.BuildOptions} */
  const shared = {
    bundle: true,
    minify: production,
    sourcemap: production ? false : 'linked',
    // Warnings are printed and then fail the build below, like everywhere else in this repo.
    logLevel: 'warning',
    absWorkingDir: root,
  };
  const results = await Promise.all([
    esbuild.build({
      ...shared,
      entryPoints: ['src/adapters/vscode/extension.ts'],
      outfile: join(out, 'extension.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['vscode'],
    }),
    esbuild.build({
      ...shared,
      entryPoints: ['src/player/main.ts'],
      outfile: join(out, 'player', 'player.js'),
      platform: 'browser',
      format: 'iife',
      target: 'chrome130',
      // The script is inlined into the page, where a linked source map cannot be resolved.
      sourcemap: false,
    }),
  ]);
  const warnings = results.flatMap((result) => result.warnings);
  if (warnings.length > 0) {
    throw new Error(`build: esbuild reported ${String(warnings.length)} warning(s).`);
  }
  mkdirSync(join(out, 'player'), { recursive: true });
  copyFileSync(join(root, 'src', 'player', 'player.css'), join(out, 'player', 'player.css'));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build({ production: process.argv.includes('--production') });
  console.log('build: wrote out/extension.js and out/player/');
}
