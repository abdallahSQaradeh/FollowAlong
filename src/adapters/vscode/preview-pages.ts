/**
 * The pages of the Resource previews (ADR 0021): an HTML file, and a Markdown file rendered to
 * HTML. Neither page runs a script: the webview is created with scripts off, and the policy says
 * `script-src 'none'` as well, so the learner's own page cannot do more than show itself.
 */

export interface PreviewPageOptions {
  /** The webview's `cspSource`: the origin local images, styles and fonts are fetched from. */
  readonly cspSource: string;
  /** The webview URI of the file's folder, with a trailing `/`: relative links resolve against it. */
  readonly baseHref: string;
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Makes relative links in `html` resolve against `baseHref`, whatever the document looks like:
 * the `<base>` goes into the `<head>` if there is one, else into a new one, and never before a
 * `<!doctype>`, which would put the page in quirks mode.
 */
export function withBase(html: string, baseHref: string): string {
  const base = `<base href="${escapeAttribute(baseHref)}">`;
  // Tags inside a comment are not the document's: blank the comments out before looking.
  const searched = html.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
  const head = /<head(\s[^>]*)?>/i.exec(searched);
  if (head !== null) {
    const end = head.index + head[0].length;
    return html.slice(0, end) + base + html.slice(end);
  }
  const root = /<html(\s[^>]*)?>/i.exec(searched);
  if (root !== null) {
    const end = root.index + root[0].length;
    return `${html.slice(0, end)}<head>${base}</head>${html.slice(end)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(searched);
  const end = doctype === null ? 0 : doctype[0].length;
  return html.slice(0, end) + base + html.slice(end);
}

function policy(cspSource: string): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    `img-src ${cspSource} data:`,
    `media-src ${cspSource}`,
    `font-src ${cspSource}`,
    // The learner's page and the Markdown it came from style themselves.
    `style-src ${cspSource} 'unsafe-inline'`,
  ].join('; ');
}

/**
 * An HTML file, shown as it is in a frame of its own: its styles cannot touch the page around it,
 * and `sandbox` without `allow-scripts` keeps scripts in it from running.
 */
export function renderHtmlPreviewPage(
  options: PreviewPageOptions & { readonly html: string },
): string {
  const { cspSource, baseHref, html } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy(cspSource)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FollowAlong preview</title>
<style>html, body { height: 100%; margin: 0; padding: 0; } iframe { border: 0; width: 100%; height: 100%; background: #fff; }</style>
</head>
<body>
<iframe sandbox="" srcdoc="${escapeAttribute(withBase(html, baseHref))}"></iframe>
</body>
</html>
`;
}

/** A Markdown file already rendered to HTML, in the editor's own colours and fonts. */
export function renderMarkdownPreviewPage(
  options: PreviewPageOptions & { readonly body: string },
): string {
  const { cspSource, baseHref, body } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy(cspSource)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${escapeAttribute(baseHref)}">
<title>FollowAlong preview</title>
<style>
body { max-width: 56rem; margin: 0 auto; padding: 0 1.5rem 3rem; line-height: 1.6;
  font-family: var(--vscode-markdown-font-family, var(--vscode-font-family, sans-serif));
  font-size: var(--vscode-markdown-font-size, 14px); }
img { max-width: 100%; }
a { color: var(--vscode-textLink-foreground); }
code, pre { font-family: var(--vscode-editor-font-family, monospace); }
pre { padding: 0.75rem 1rem; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
code { background: var(--vscode-textCodeBlock-background); }
pre code { background: none; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--vscode-editorWidget-border, currentColor); padding: 0.25rem 0.6rem; }
blockquote { margin: 0; padding: 0 1rem; border-left: 4px solid var(--vscode-textBlockQuote-border); }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
