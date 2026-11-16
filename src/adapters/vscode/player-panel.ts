/**
 * The Player port in VS Code: the player page in the spot the core names (ADR 0049). In
 * `editorSplit` it is a webview panel in an editor group beside the code; in `bottomPanel` and
 * `secondarySidebar` it is a webview view in a FollowAlong view container there. It only
 * translates: protocol messages go to and from the page, file paths become webview URIs.
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
import type { VideoSpot } from '../../core/video-placement.js';
import { renderPlayerHtml } from '../../player/page.js';
import {
  parsePlayerEvent,
  type PlayerCommand,
  type PlayerEvent,
} from '../../protocol/player-messages.js';

export const playerViewType = 'followalong.player';

/** The spots that are a webview view, not an editor tab. */
type ViewSpot = Exclude<VideoSpot, 'editorSplit'>;

/** The webview view of each view spot, and the view container that holds it (package.json). */
export const playerViews: Readonly<
  Record<ViewSpot, { readonly view: string; readonly container: string }>
> = {
  bottomPanel: { view: 'followalong.videoPanel', container: 'followalong-video-panel' },
  secondarySidebar: { view: 'followalong.videoSidebar', container: 'followalong-video-sidebar' },
};

/** The context key the views' `when` clauses read: only the spot the player is in shows. */
const spotContextKey = 'followalong.videoSpot';

/** The page in one spot: a webview, how to bring it to the front, and how to drop it. */
interface Host {
  readonly spot: VideoSpot;
  readonly webview: vscode.Webview;
  /** The editor group it is in, for a panel. */
  readonly viewColumn: vscode.ViewColumn | undefined;
  readonly visible: boolean;
  reveal(): void;
  /** Drops the page; the core is not told, because it asked for it (a move). */
  drop(): void;
}

export class PlayerPanel implements PlayerPort, vscode.Disposable {
  private host: Host | undefined;
  /** A view spot the player was moved to, until VS Code resolves its view. */
  private awaitedView: { readonly spot: ViewSpot; readonly title: string } | undefined;
  /** The webview views VS Code has resolved and not disposed yet, by spot. */
  private readonly views = new Map<ViewSpot, vscode.WebviewView>();
  private roots: readonly string[] = [];
  private page: { readonly script: string; readonly style: string } | undefined;
  private readonly events = new vscode.EventEmitter<PlayerEvent>();
  private readonly closed = new vscode.EventEmitter<undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionPath: string,
    private readonly logger: Logger,
    /** Hands focus back to the code after VS Code focused a view it opened. */
    private readonly returnFocus: () => void,
  ) {
    for (const [spot, { view }] of Object.entries(playerViews) as [
      ViewSpot,
      typeof playerViews.bottomPanel,
    ][]) {
      this.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
          view,
          {
            resolveWebviewView: (resolved) => {
              this.resolved(spot, resolved);
            },
          },
          // The Lesson keeps playing while the panel or the sidebar is closed.
          { webviewOptions: { retainContextWhenHidden: true } },
        ),
      );
    }
  }

  /** The editor group the player is in, if it is open in one. */
  get viewColumn(): vscode.ViewColumn | undefined {
    return this.host?.viewColumn;
  }

  /** Where the player is, and whether VS Code shows it, for the smoke test. */
  get hosted(): { readonly spot: VideoSpot; readonly visible: boolean } | undefined {
    return this.host === undefined
      ? undefined
      : { spot: this.host.spot, visible: this.host.visible };
  }

  show(options: PlayerShowOptions): PlayerShowResult {
    const { title, resourceRoots, spot } = options;
    const sameRoots =
      resourceRoots.length === this.roots.length &&
      resourceRoots.every((root, index) => root === this.roots[index]);
    this.roots = resourceRoots;
    if (this.host?.spot === spot) {
      this.retitle(title);
      if (!sameRoots) {
        // Other folders: the same page takes them, and VS Code reloads it, which posts `ready`
        // again. The reload loses the click that lets the page start playback (#12 D3), which is
        // why the core keeps the folders the same across Courses under the roots (ADR 0022).
        this.host.webview.options = this.webviewOptions();
      }
      this.host.reveal();
      return sameRoots ? 'revealed' : 'created';
    }
    if (this.awaitedView?.spot === spot) {
      this.awaitedView = { spot, title };
      return 'created';
    }
    // Another spot: a new page there (a panel and a view cannot share one, ADR 0049).
    const old = this.host;
    this.host = undefined;
    this.awaitedView = undefined;
    old?.drop();
    void vscode.commands.executeCommand('setContext', spotContextKey, spot);
    if (spot === 'editorSplit') {
      this.host = this.openPanel(title);
    } else {
      this.openView(spot, title);
    }
    return 'created';
  }

  resourceUri(absolutePath: string): string {
    if (this.host === undefined) {
      throw new Error('resourceUri: the player is not open.');
    }
    return this.host.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString();
  }

  send(command: PlayerCommand): void {
    void this.host?.webview.postMessage(command);
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
    this.host?.drop();
    this.host = undefined;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.events.dispose();
    this.closed.dispose();
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: this.roots.map((root) => vscode.Uri.file(root)),
    };
  }

  private retitle(title: string): void {
    const host = this.host;
    if (host === undefined) {
      return;
    }
    if (host.spot === 'editorSplit') {
      this.panelTitle?.(title);
    } else {
      const view = this.views.get(host.spot);
      if (view !== undefined) {
        view.description = title;
      }
    }
  }

  /** Sets the title of the open panel; set while the player is a panel. */
  private panelTitle: ((title: string) => void) | undefined;

  /** The player page in a webview panel beside the code (`editorSplit`). */
  private openPanel(title: string): Host {
    const panel = vscode.window.createWebviewPanel(
      playerViewType,
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // The Lesson keeps playing while another tab in its group is in front.
      { ...this.webviewOptions(), retainContextWhenHidden: true },
    );
    let dropped = false;
    const host: Host = {
      spot: 'editorSplit',
      webview: panel.webview,
      get viewColumn() {
        return panel.viewColumn;
      },
      get visible() {
        return panel.visible;
      },
      reveal: () => {
        panel.reveal(undefined, true);
      },
      drop: () => {
        dropped = true;
        panel.dispose();
      },
    };
    this.panelTitle = (next) => {
      panel.title = next;
    };
    panel.onDidDispose(() => {
      // A panel dropped for a move is not a close: the Lesson is still there.
      if (!dropped && this.host === host) {
        this.lost();
      }
    });
    this.startPage(host);
    return host;
  }

  /**
   * Shows the view of `spot`: VS Code makes its view container visible (the `when` clause now
   * holds) and resolves the view, or the view it resolved before takes a new page.
   */
  private openView(spot: ViewSpot, title: string): void {
    const existing = this.views.get(spot);
    if (existing !== undefined) {
      this.host = this.viewHost(spot, existing);
      existing.description = title;
      this.startPage(this.host);
      this.host.reveal();
      return;
    }
    this.awaitedView = { spot, title };
    // Opening the container focuses the view: focus goes back to the code once it is open.
    void vscode.commands
      .executeCommand(`workbench.view.extension.${playerViews[spot].container}`)
      .then(this.returnFocus, (error: unknown) => {
        this.logger.log({
          level: 'error',
          message: `Could not open the ${spot} view: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }

  /** VS Code resolved the view of `spot`: it is the player when the player was moved there. */
  private resolved(spot: ViewSpot, view: vscode.WebviewView): void {
    this.views.set(spot, view);
    view.onDidDispose(() => {
      this.views.delete(spot);
      // A view hidden for a move is not a close; the learner closing the view is.
      if (this.host?.spot === spot) {
        this.lost();
      }
    });
    if (this.awaitedView?.spot !== spot) {
      return;
    }
    view.description = this.awaitedView.title;
    this.awaitedView = undefined;
    this.host = this.viewHost(spot, view);
    this.startPage(this.host);
  }

  private viewHost(spot: ViewSpot, view: vscode.WebviewView): Host {
    return {
      spot,
      webview: view.webview,
      viewColumn: undefined,
      get visible() {
        return view.visible;
      },
      reveal: () => {
        view.show(true);
      },
      drop: () => {
        // The `when` clause hides the view once the context key names another spot; until then
        // it must not play on.
        view.webview.html = '';
      },
    };
  }

  /** The learner closed the player: whatever it had loaded is gone. */
  private lost(): void {
    this.host = undefined;
    this.roots = [];
    void vscode.commands.executeCommand('setContext', spotContextKey, undefined);
    this.closed.fire(undefined);
  }

  /** Starts a new player page in `host`, and forwards what it posts while it is the player. */
  private startPage(host: Host): void {
    const { webview } = host;
    webview.options = this.webviewOptions();
    const listening = webview.onDidReceiveMessage((raw: unknown) => {
      if (this.host !== host) {
        // A page dropped for a move: what it posts is about a player that is gone.
        listening.dispose();
        return;
      }
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
    webview.html = renderPlayerHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(18).toString('base64'),
      script: page.script,
      style: page.style,
    });
  }

  private loadPage(): { readonly script: string; readonly style: string } {
    this.page ??= {
      script: readFileSync(join(this.extensionPath, 'out', 'player', 'player.js'), 'utf8'),
      style: readFileSync(join(this.extensionPath, 'out', 'player', 'player.css'), 'utf8'),
    };
    return this.page;
  }
}
