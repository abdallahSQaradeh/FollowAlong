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
<video id="video" controls controlslist="nodownload noplaybackrate noremoteplayback" disablepictureinpicture disableremoteplayback preload="auto"></video>
<div class="overlay" aria-hidden="true"></div>
<div class="zoom-box" hidden></div>
<div class="zoom-tools" role="toolbar" aria-label="Zoom">
<output class="zoom-level" aria-label="Zoom level">1×</output>
<button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
<button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">＋</button>
<button type="button" data-zoom="area" aria-label="Zoom to an area" title="Zoom to an area: drag a box" aria-pressed="false"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" fill="none" stroke="currentColor" stroke-dasharray="2 1.5"/></svg></button>
<button type="button" data-zoom="reset" aria-label="Reset zoom" title="Reset zoom (double-click the picture)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 2.5v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button>
</div>
<div class="sound-notice" hidden>
<p class="sound-text"></p>
<button class="sound-skip" type="button" hidden>Play without sound</button>
</div>
<button class="next" type="button" hidden></button>
</main>
<audio preload="auto"></audio>
<script nonce="${nonce}">${inline(options.script, 'script')}</script>
</body>
</html>
`;
}
