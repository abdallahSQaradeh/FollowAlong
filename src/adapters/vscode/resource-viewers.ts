/**
 * The Resource tabs FollowAlong draws itself (ADR 0021): the preview of an HTML or Markdown file,
 * and the PDF viewer. Each file has at most one tab; opening it again brings that tab forward, in
 * the editor group the placement names, in case the learner moved it. Like every Resource, a tab
 * never takes focus.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import { renderPdfViewerPage } from '../../player/pdf-page.js';
import { parsePdfViewerEvent, type PdfViewerEvent } from '../../protocol/pdf-viewer-messages.js';
import { renderHtmlPreviewPage, renderMarkdownPreviewPage } from './preview-pages.js';

/** The view type of the preview tab (VS Code prefixes it for a tab's input). */
export const previewViewType = 'followalong.preview';

/** The view type of the PDF viewer tab. */
export const pdfViewType = 'followalong.pdf';

/** Whether a tab's webview is one of FollowAlong's Resource tabs. */
export function isResourceViewType(viewType: string): boolean {
  return viewType.endsWith(previewViewType) || viewType.endsWith(pdfViewType);
}

/** Opens `path` in VS Code's own editor for it (text, or an image preview), beside the code. */
export async function openInEditor(path: string, column: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path), {
    viewColumn: column,
    preview: false,
    preserveFocus: true,
  });
}

export class ResourceViewers implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly pdfEvents = new vscode.EventEmitter<PdfViewerEvent>();
  private pdfScripts: { readonly script: string; readonly worker: string } | undefined;

  /** What the PDF viewers report: a first page drawn, or a PDF that could not be shown. */
  readonly onPdfEvent = this.pdfEvents.event;

  constructor(
    private readonly extensionPath: string,
    private readonly logger: Logger,
  ) {}

  /** Opens `path`, a PDF, in the FollowAlong viewer in the editor group `column`. */
  openPdf(path: string, column: vscode.ViewColumn): Promise<void> {
    const key = `pdf:${path}`;
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.reveal(column, true);
      return Promise.resolve();
    }
    const file = vscode.Uri.file(path);
    const panel = vscode.window.createWebviewPanel(
      pdfViewType,
      basename(path),
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        // The PDF file itself is all the viewer may read, not its folder (ADR 0046): its script
        // and the pdf.js worker are inlined in the page (ADR 0004), so no root of the extension
        // is needed.
        localResourceRoots: [file],
      },
    );
    this.panels.set(key, panel);
    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const event = parsePdfViewerEvent(raw);
      if (event === undefined) {
        this.logger.log({
          level: 'warn',
          message: `Unknown message from the PDF viewer: ${JSON.stringify(raw)}`,
        });
        return;
      }
      if (event.type === 'failed') {
        this.logger.log({ level: 'warn', message: `Could not show ${path}: ${event.message}` });
      }
      this.pdfEvents.fire(event);
    });
    const { script, worker } = this.loadPdfScripts();
    panel.webview.html = renderPdfViewerPage({
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(18).toString('base64'),
      pdfUri: panel.webview.asWebviewUri(vscode.Uri.file(path)).toString(),
      script,
      worker,
    });
    return Promise.resolve();
  }

  private loadPdfScripts(): { readonly script: string; readonly worker: string } {
    this.pdfScripts ??= {
      script: readFileSync(join(this.extensionPath, 'out', 'pdf', 'pdf-viewer.js'), 'utf8'),
      worker: readFileSync(join(this.extensionPath, 'out', 'pdf', 'pdf.worker.js'), 'utf8'),
    };
    return this.pdfScripts;
  }

  /** Opens `path`, an HTML or Markdown file, as a preview in the editor group `column`. */
  async openPreview(
    kind: 'html' | 'markdown',
    path: string,
    column: vscode.ViewColumn,
  ): Promise<void> {
    const text = await readFile(path, 'utf8');
    const body = kind === 'markdown' ? await this.renderMarkdown(text) : undefined;
    if (kind === 'markdown' && body === undefined) {
      // VS Code's Markdown support is off: the file still opens, as text.
      await openInEditor(path, column);
      return;
    }
    const key = `${kind}:${path}`;
    const existing = this.panels.get(key);
    const panel =
      existing ??
      vscode.window.createWebviewPanel(
        previewViewType,
        basename(path),
        { viewColumn: column, preserveFocus: true },
        {
          enableScripts: false,
          // Only what sits next to the file can be shown in it.
          localResourceRoots: [vscode.Uri.file(dirname(path))],
        },
      );
    if (existing === undefined) {
      this.panels.set(key, panel);
      panel.onDidDispose(() => this.panels.delete(key));
    } else {
      existing.reveal(column, true);
    }
    const { webview } = panel;
    const baseHref = `${webview.asWebviewUri(vscode.Uri.file(dirname(path))).toString()}/`;
    webview.html =
      body === undefined
        ? renderHtmlPreviewPage({ cspSource: webview.cspSource, baseHref, html: text })
        : renderMarkdownPreviewPage({ cspSource: webview.cspSource, baseHref, body });
  }

  /** The Markdown as HTML, by VS Code's own renderer; `undefined` when that is not available. */
  private async renderMarkdown(text: string): Promise<string | undefined> {
    try {
      return await vscode.commands.executeCommand<string>('markdown.api.render', text);
    } catch (error) {
      this.logger.log({
        level: 'warn',
        message: `VS Code could not render Markdown, opening the file as text: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) {
      panel.dispose();
    }
    this.panels.clear();
    this.pdfEvents.dispose();
  }
}
