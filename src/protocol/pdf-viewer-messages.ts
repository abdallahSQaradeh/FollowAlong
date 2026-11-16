/**
 * What the PDF viewer webview tells the extension (ADR 0021). The viewer takes no commands: the
 * extension builds its page with the PDF's address, and the viewer reports how that went.
 */

/** PDF viewer → extension. */
export type PdfViewerEvent =
  /** The first page is drawn; `pages` is how many the document has. */
  | { readonly type: 'rendered'; readonly pages: number }
  /** The document could not be opened or drawn. */
  | { readonly type: 'failed'; readonly message: string };

/** Returns the event, or `undefined` when `raw` is not a well-formed PDF viewer event. */
export function parsePdfViewerEvent(raw: unknown): PdfViewerEvent | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { type, pages, message } = raw as Record<string, unknown>;
  if (type === 'rendered') {
    return typeof pages === 'number' && Number.isInteger(pages) && pages >= 0
      ? { type, pages }
      : undefined;
  }
  if (type === 'failed') {
    return typeof message === 'string' ? { type, message } : undefined;
  }
  return undefined;
}
