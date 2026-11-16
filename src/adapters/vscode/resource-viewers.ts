/**
 * The Resource tabs FollowAlong draws itself (ADR 0021): the preview of an HTML or Markdown file.
 * Each file has at most one tab; opening it again brings that tab forward. Like every Resource, a
 * tab opens in the editor group the placement names and never takes focus.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import { renderHtmlPreviewPage, renderMarkdownPreviewPage } from './preview-pages.js';

/** The view type of the preview tab (VS Code prefixes it for a tab's input). */
export const previewViewType = 'followalong.preview';

/** Whether a tab's webview is one of FollowAlong's Resource tabs. */
export function isResourceViewType(viewType: string): boolean {
  return viewType.endsWith(previewViewType);
}

export class ResourceViewers implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly logger: Logger) {}

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
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path), {
        viewColumn: column,
        preview: false,
        preserveFocus: true,
      });
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
      existing.reveal(undefined, true);
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
  }
}
