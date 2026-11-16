// @ts-check
/**
 * Builds the extension with esbuild (ADR 0004):
 * - out/extension.js: the extension host bundle (CommonJS, Node), with `vscode` left external;
 * - out/player/player.js and out/player/player.css: the webview script (an IIFE for the browser)
 *   and stylesheet, which the extension inlines into the player page;
 * - out/pdf/pdf-viewer.js and out/pdf/pdf.worker.js: the PDF viewer's script and the pdf.js worker
 *   (IIFEs for the browser), which the extension inlines into the PDF viewer page (ADR 0021).
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
    esbuild.build({
      ...shared,
      entryPoints: ['src/player/pdf-viewer.ts'],
      outfile: join(out, 'pdf', 'pdf-viewer.js'),
      platform: 'browser',
      format: 'iife',
      target: 'chrome130',
      sourcemap: false,
    }),
    esbuild.build({
      ...shared,
      entryPoints: ['node_modules/pdfjs-dist/build/pdf.worker.mjs'],
      outfile: join(out, 'pdf', 'pdf.worker.js'),
      platform: 'browser',
      format: 'iife',
      target: 'chrome130',
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
  console.log('build: wrote out/extension.js, out/player/ and out/pdf/');
}
