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
  private readonly closed = new vscode.EventEmitter<undefined>();

  constructor(
    private readonly extensionPath: string,
    private readonly logger: Logger,
  ) {}

  /** The editor group the player is in, if it is open in one. */
  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel?.viewColumn;
  }

  show(options: PlayerShowOptions): PlayerShowResult {
    const { title, resourceRoots } = options;
    const sameRoots =
      resourceRoots.length === this.roots.length &&
      resourceRoots.every((root, index) => root === this.roots[index]);
    if (this.panel !== undefined) {
      this.panel.title = title;
      if (!sameRoots) {
        // Another Course: the same panel takes the new roots, and VS Code reloads its page, which
        // posts `ready` again. Keeping the panel keeps its tab where the learner put it and the
        // click that lets the player start playback (#12 D3, ADR 0022), and is not a close.
        this.panel.webview.options = {
          ...this.panel.webview.options,
          localResourceRoots: resourceRoots.map((root) => vscode.Uri.file(root)),
        };
        this.roots = resourceRoots;
      }
      this.panel.reveal(undefined, true);
      return sameRoots ? 'revealed' : 'created';
    }
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
      // A panel replaced by `show` for another Course is not a close: the Lesson is still there.
      if (this.panel === panel) {
        this.panel = undefined;
        this.roots = [];
        this.closed.fire(undefined);
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

  onDidClose(listener: () => void): Disposable {
    return this.closed.event(() => {
      listener();
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.events.dispose();
    this.closed.dispose();
  }

  private loadPage(): { readonly script: string; readonly style: string } {
    this.page ??= {
      script: readFileSync(join(this.extensionPath, 'out', 'player', 'player.js'), 'utf8'),
      style: readFileSync(join(this.extensionPath, 'out', 'player', 'player.css'), 'utf8'),
    };
    return this.page;
  }
}
