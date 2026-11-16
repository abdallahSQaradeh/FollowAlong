/**
 * The player's HTML page, with its CSS and JS inlined (spec #12, Player; ADR 0004). The VS Code
 * adapter and the Seam 2 harness both build the page with this function, so Playwright tests run
 * the same page the webview shows.
 */

export interface PlayerPageOptions {
  /** The webview's `cspSource`: the origin media is fetched from. */
  readonly cspSource: string;
  /** A fresh random value per page, allowing only the inlined style and script. */
  readonly nonce: string;
  /** The bundled player script (out/player/player.js). */
  readonly script: string;
  /** The player stylesheet (out/player/player.css). */
  readonly style: string;
}

/** Stops inlined text from closing its own <script> or <style> element. */
function inline(text: string, tag: 'script' | 'style'): string {
  return text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

export function renderPlayerHtml(options: PlayerPageOptions): string {
  const { cspSource, nonce } = options;
  const policy = [
    "default-src 'none'",
    // WebM plays from a MediaSource object URL; the bytes are fetched from the Course folder.
    `media-src ${cspSource} blob:`,
    `connect-src ${cspSource}`,
    `img-src ${cspSource} data:`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FollowAlong player</title>
<style nonce="${nonce}">${inline(options.style, 'style')}</style>
</head>
<body>
<main class="stage">
<video id="video" controls preload="auto"></video>
<div class="overlay" aria-hidden="true"></div>
</main>
<script nonce="${nonce}">${inline(options.script, 'script')}</script>
</body>
</html>
`;
}
