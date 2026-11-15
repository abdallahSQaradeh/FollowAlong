# esbuild bundles, an inlined player page, and a win32-x64 .vsix

`scripts/build.mjs` builds two esbuild bundles into `out/`: `out/extension.js` (CommonJS for Node,
`vscode` external) and `out/player/player.js` (an IIFE for the webview), plus `player.css`. The
extension reads the player bundle and inlines it, with the CSS, into the page that
`renderPlayerHtml` (`src/player/page.ts`) builds, under a Content Security Policy that allows only
that nonce's script and style, media from the webview resource origin and `blob:` (MediaSource),
and fetches from the resource origin. Seam 2 loads the same function's page with the same built
bundle (Playwright `globalSetup` builds it), and the smoke test builds before VS Code loads the
extension. `npm run package` (`scripts/package.mjs`) makes a production build and runs vsce with
`--target win32-x64`, no `node_modules` (the bundles hold everything) and the file allowlist in
`package.json` `"files"`.

## Considered options

- **CommonJS stays** (ADR 0001 left it open). The extension host loads CommonJS without
  configuration, the smoke suite already compiles to it, and esbuild turns the TypeScript's ES
  imports into one CommonJS file either way, so `"type": "module"` would buy nothing now.
- **`tsc` emit instead of a bundler.** Rejected: the webview needs one script with no module
  loader, and an unbundled extension would have to ship `node_modules`.
- **Loading the player script with `<script src=asWebviewUri(…)>`.** Rejected for the spec's
  "CSS/JS inlined" (from the prototype): one HTML string is the whole page, so Seam 2 needs no
  webview resource server for code, and the page cannot load anything the policy did not name.
- **A target-specific .vsix.** The bundled ffmpeg (a later ticket) is a Windows x64 binary, so the
  package is `win32-x64` from the start.
- **DOM types in the root `tsconfig.json`.** The post-edit hook and `npm run typecheck` check one
  project, so the player and the Playwright specs share it with the Node code. ESLint keeps the
  runtimes apart instead: `src/core` may not use `window`, `document`, `navigator` or
  `localStorage`, and `src/player` may not import Node built-ins, `vscode`, the core or adapters.

## Workspace trust

`package.json` declares `capabilities.untrustedWorkspaces.supported: true` and
`virtualWorkspaces: false`. FollowAlong never runs or reads workspace code and writes nothing into
the workspace. The Practice area is often a freshly downloaded, untrusted folder, and VS Code would
otherwise disable FollowAlong in it. FollowAlong reads local Course files from disk, so virtual
workspaces are not supported. Source: orchestrator answer, spec #12 "Decisions during build".
