/**
 * The Player port as a webview panel in an editor group beside the code (the `editorSplit` spot).
 * It only translates: protocol messages go to and from the webview, file paths become webview URIs.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import type {
  Disposable,
  PlayerPort,
  PlayerShowOptions,
  PlayerShowResult,
} from '../../core/ports.js';
import { renderPlayerHtml } from '../../player/page.js';
import {
  parsePlayerEvent,
  type PlayerCommand,
  type PlayerEvent,
} from '../../protocol/player-messages.js';

export const playerViewType = 'followalong.player';

export class PlayerPanel implements PlayerPort, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private roots: readonly string[] = [];
  private page: { readonly script: string; readonly style: string } | undefined;
  private readonly events = new vscode.EventEmitter<PlayerEvent>();

  constructor(
    private readonly extensionPath: string,
    private readonly logger: Logger,
  ) {}

  show(options: PlayerShowOptions): PlayerShowResult {
    const { title, resourceRoots } = options;
    const sameRoots =
      resourceRoots.length === this.roots.length &&
      resourceRoots.every((root, index) => root === this.roots[index]);
    if (this.panel !== undefined && sameRoots) {
      this.panel.title = title;
      this.panel.reveal(undefined, true);
      return 'revealed';
    }
    // localResourceRoots are fixed when a webview is created, so a new Course gets a new panel.
    this.panel?.dispose();
    const panel = vscode.window.createWebviewPanel(
      playerViewType,
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // The Lesson keeps playing while another tab in its group is in front.
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots.map((root) => vscode.Uri.file(root)),
      },
    );
    this.panel = panel;
    this.roots = resourceRoots;
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.roots = [];
      }
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const event = parsePlayerEvent(raw);
      if (event === undefined) {
        this.logger.log({
          level: 'warn',
          message: `Unknown message from the player: ${JSON.stringify(raw)}`,
        });
        return;
      }
      this.events.fire(event);
    });
    const page = this.loadPage();
    panel.webview.html = renderPlayerHtml({
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(18).toString('base64'),
      script: page.script,
      style: page.style,
    });
    return 'created';
  }

  resourceUri(absolutePath: string): string {
    if (this.panel === undefined) {
      throw new Error('resourceUri: the player is not open.');
    }
    return this.panel.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString();
  }

  send(command: PlayerCommand): void {
    void this.panel?.webview.postMessage(command);
  }

  onEvent(listener: (event: PlayerEvent) => void): Disposable {
    return this.events.event(listener);
  }

  dispose(): void {
    this.panel?.dispose();
    this.events.dispose();
  }

  private loadPage(): { readonly script: string; readonly style: string } {
    this.page ??= {
      script: readFileSync(join(this.extensionPath, 'out', 'player', 'player.js'), 'utf8'),
      style: readFileSync(join(this.extensionPath, 'out', 'player', 'player.css'), 'utf8'),
    };
    return this.page;
  }
}
