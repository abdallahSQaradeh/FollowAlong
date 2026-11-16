/**
 * The PDF viewer's HTML page (ADR 0021), with its script, style and the pdf.js worker's source
 * inlined, like the player's (ADR 0004). The VS Code adapter and the Seam 2 harness both build it
 * with this function.
 */

export interface PdfViewerPageOptions {
  /** The webview's `cspSource`: the origin the PDF is fetched from. */
  readonly cspSource: string;
  /** A fresh random value per page, allowing only the inlined style and scripts. */
  readonly nonce: string;
  /** The webview URI of the PDF. */
  readonly pdfUri: string;
  /** The bundled viewer script (out/pdf/pdf-viewer.js). */
  readonly script: string;
  /** The bundled pdf.js worker (out/pdf/pdf.worker.js), run from a `blob:` URL. */
  readonly worker: string;
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Source as the text of a JavaScript string literal that cannot end its own <script> element. */
function asScriptString(source: string): string {
  return JSON.stringify(source)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--');
}

const style = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; color: var(--vscode-foreground);
  background: var(--vscode-editor-background); font-family: var(--vscode-font-family, sans-serif); }
.toolbar { display: flex; gap: 0.5rem; align-items: center; padding: 0.25rem 0.75rem;
  border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
.toolbar button { color: var(--vscode-button-secondaryForeground); cursor: pointer;
  background: var(--vscode-button-secondaryBackground); border: 0; padding: 0.15rem 0.6rem; }
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.toolbar .spacer { flex: 1; }
#status { padding: 1rem; }
#pages { flex: 1; overflow: auto; padding: 1rem 0; text-align: center; }
.page { position: relative; margin: 0 auto 1rem; background: #fff; box-shadow: 0 1px 6px rgb(0 0 0 / 40%); }
.page canvas { display: block; }
`;

export function renderPdfViewerPage(options: PdfViewerPageOptions): string {
  const { cspSource, nonce } = options;
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    // The PDF is fetched from the folder it is in, by the worker, which runs from a blob: URL.
    `connect-src ${cspSource}`,
    'worker-src blob:',
    'img-src blob: data:',
    'font-src blob: data:',
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FollowAlong PDF viewer</title>
<style nonce="${nonce}">${style.replace(/<\/style/gi, '<\\/style')}</style>
</head>
<body data-pdf="${escapeAttribute(options.pdfUri)}">
<div class="toolbar">
<button id="zoom-out" type="button" title="Zoom out">−</button>
<span id="level">100%</span>
<button id="zoom-in" type="button" title="Zoom in">＋</button>
<button id="zoom-fit" type="button" title="Fit to width">Fit width</button>
<span class="spacer"></span>
<span id="position"></span>
</div>
<div id="status">Opening the PDF…</div>
<div id="pages"></div>
<script nonce="${nonce}">window.followalongPdfWorker = ${asScriptString(options.worker)};</script>
<script nonce="${nonce}">${options.script.replace(/<\/(script)/gi, '<\\/$1')}</script>
</body>
</html>
`;
}
