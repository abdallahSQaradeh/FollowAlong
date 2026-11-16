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
import type { FocusedPart } from './focus-return.js';
import type {
  Disposable,
  PlayerPort,
  PlayerShowOptions,
  PlayerShowResult,
} from '../../core/ports.js';
import { spotLabels, type VideoSpot } from '../../core/video-placement.js';
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

/** The command that closes the part of the window each view spot is in. */
const closeCommands: Readonly<Record<ViewSpot, string>> = {
  bottomPanel: 'workbench.action.closePanel',
  secondarySidebar: 'workbench.action.closeAuxiliaryBar',
};

/** How long a move waits for VS Code to resolve the view of its spot, in ms. */
const viewWaitMs = 5000;

/** How long after a move a view hidden by the focus return is shown again, in ms. */
const keepShownMs = 1000;

/** The context key the views' `when` clauses read: only the spot the player is in shows. */
const spotContextKey = 'followalong.videoSpot';

/** The page in one spot: a webview, how to bring it to the front, and how to drop it. */
interface Host {
  readonly spot: VideoSpot;
  readonly webview: vscode.Webview;
  /** The editor group it is in, for a panel. */
  readonly viewColumn: vscode.ViewColumn | undefined;
  readonly visible: boolean;
  /** Shows the Lesson's title: the panel's tab title, or the view's description. */
  setTitle(title: string): void;
  reveal(): void;
  /**
   * Drops the page and stops forwarding what it posts; the core is not told (it asked: a move).
   * Resolves once VS Code has closed what showed it, where that needs closing.
   */
  drop(): Promise<void>;
}

/** Where the player is, and whether VS Code shows it. */
export interface PlayerPlace {
  readonly spot: VideoSpot;
  readonly visible: boolean;
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
    private readonly returnFocus: () => Promise<FocusedPart>,
  ) {
    for (const spot of ['bottomPanel', 'secondarySidebar'] as const) {
      this.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
          playerViews[spot].view,
          {
            resolveWebviewView: (view) => {
              this.viewResolved(spot, view);
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
  get place(): PlayerPlace | undefined {
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
      this.host.setTitle(title);
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
    const left = this.host?.drop() ?? Promise.resolve();
    this.host = undefined;
    this.awaitedView = undefined;
    this.stopWatching();
    // The old view's container is closed before its `when` clause hides it (`drop`).
    const shown = left.then(() => this.showSpot(spot));
    if (spot === 'editorSplit') {
      this.host = this.openPanel(title);
      void shown;
    } else {
      this.awaitedView = { spot, title };
      // The view shows only once its `when` clause holds: set the key first, then open it.
      void shown.then(() => {
        this.openView(spot);
      });
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
    void this.host?.drop();
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

  /** Sets the context key the views' `when` clauses read: only `spot`'s view, if any, shows. */
  private async showSpot(spot: VideoSpot | undefined): Promise<void> {
    await vscode.commands.executeCommand('setContext', spotContextKey, spot);
  }

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
    /** What the page posts is forwarded until the host is dropped. */
    const forwarding: vscode.Disposable[] = [];
    const host: Host = {
      spot: 'editorSplit',
      webview: panel.webview,
      get viewColumn() {
        return panel.viewColumn;
      },
      get visible() {
        return panel.visible;
      },
      setTitle: (next) => {
        panel.title = next;
      },
      reveal: () => {
        panel.reveal(undefined, true);
      },
      drop: () => {
        dropped = true;
        for (const subscription of forwarding) {
          subscription.dispose();
        }
        panel.dispose();
        return Promise.resolve();
      },
    };
    panel.onDidDispose(() => {
      // A panel dropped for a move is not a close: the Lesson is still there.
      if (!dropped && this.host === host) {
        this.playerGone();
      }
    });
    forwarding.push(this.startPage(host));
    return host;
  }

  /**
   * Shows the view of the spot the player is awaited in, and starts the page in whichever view
   * VS Code then shows. VS Code disposes a view its `when` clause hides and resolves a new one
   * when it shows again (trace, CI run 43897862321), so the page starts in the view it resolves
   * now; a view it still holds is used once it is visible. The view is opened with its own
   * `.focus` command either way.
   */
  private openView(spot: ViewSpot): void {
    if (this.awaitedView?.spot !== spot) {
      // Moved on meanwhile.
      return;
    }
    const existing = this.views.get(spot);
    const watching = existing?.onDidChangeVisibility(() => {
      if (existing.visible) {
        this.adopt(spot, existing);
      }
    });
    // A view that never comes (VS Code did not resolve it) must not leave the core waiting for a
    // page: after a while the player counts as gone, and the learner is told.
    const giveUp = setTimeout(() => {
      if (this.awaitedView?.spot !== spot) {
        return;
      }
      this.awaitedView = undefined;
      this.stopWatching();
      this.logger.log({
        level: 'warn',
        message: `The ${spot} view did not open within ${String(viewWaitMs)} ms.`,
      });
      void vscode.window.showWarningMessage(
        `FollowAlong could not show the video in the ${spotLabels[spot].toLowerCase()}. Open the Lesson again, or move the video to another spot.`,
      );
      this.playerGone();
    }, viewWaitMs);
    const stopWatchingVisibility = (): void => {
      watching?.dispose();
    };
    this.stopWatching = () => {
      clearTimeout(giveUp);
      stopWatchingVisibility();
    };
    // `<view>.focus` opens the container and brings the view back also when the learner hid it
    // from the container's menu. It focuses the view: focus goes back to the code once it is open.
    vscode.commands.executeCommand(`${playerViews[spot].view}.focus`).then(
      () => {
        if (existing?.visible === true) {
          this.adopt(spot, existing);
        }
        void this.returnFocus().then((focused) => {
          // Focus return wins (#12 D12): a terminal the learner types in stays in front, even
          // when it hides the video in the bottom panel.
          if (focused !== 'terminal') {
            this.keepShown(spot);
          }
        });
      },
      (error: unknown) => {
        this.logger.log({
          level: 'error',
          message: `Could not open the ${spot} view: ${error instanceof Error ? error.message : String(error)}`,
        });
        // No player will show: the core must not wait for it.
        if (this.awaitedView?.spot === spot) {
          this.awaitedView = undefined;
          this.stopWatching();
          this.playerGone();
        }
      },
    );
  }

  /**
   * Shows the player's view in `spot` again, without taking focus, if handing focus back to the
   * code hid it. After the player left an editor group, focusing the code editor hides the bottom
   * panel it was just opened in (smoke test, CI run 43898701222: the view went hidden 25 ms after
   * the focus return).
   */
  private keepShown(spot: ViewSpot): void {
    const host = this.host;
    const view = this.views.get(spot);
    if (host?.spot !== spot || view?.webview !== host.webview) {
      return;
    }
    if (!view.visible) {
      host.reveal();
      return;
    }
    // The hide can also come just after: watch the next change for a moment.
    const watching = view.onDidChangeVisibility(() => {
      watching.dispose();
      if (!view.visible && this.host === host) {
        host.reveal();
      }
    });
    setTimeout(() => {
      watching.dispose();
    }, keepShownMs);
  }

  /** Stops waiting for a view VS Code resolved before to become visible. */
  private stopWatching: () => void = () => undefined;

  /** The player is awaited in `spot`, and `view` is the view VS Code shows there: start its page. */
  private adopt(spot: ViewSpot, view: vscode.WebviewView): void {
    const awaited = this.awaitedView;
    if (awaited?.spot !== spot) {
      return;
    }
    this.awaitedView = undefined;
    this.stopWatching();
    this.host = this.viewHost(spot, view, awaited.title);
  }

  /** VS Code resolved the view of `spot`: it is the player when the player is awaited there. */
  private viewResolved(spot: ViewSpot, view: vscode.WebviewView): void {
    this.views.set(spot, view);
    view.onDidDispose(() => {
      // VS Code may have resolved a newer view for the spot since.
      if (this.views.get(spot) === view) {
        this.views.delete(spot);
      }
      // A view hidden for a move is not a close; the learner closing the view is.
      if (this.host?.webview === view.webview) {
        this.playerGone();
      }
    });
    this.adopt(spot, view);
  }

  /** A new player page in `view`, titled `title`. */
  private viewHost(spot: ViewSpot, view: vscode.WebviewView, title: string): Host {
    /** What the page posts is forwarded until the host is dropped. */
    const forwarding: vscode.Disposable[] = [];
    const host: Host = {
      spot,
      webview: view.webview,
      viewColumn: undefined,
      get visible() {
        return view.visible;
      },
      setTitle: (next) => {
        view.description = next;
      },
      reveal: () => {
        view.show(true);
      },
      drop: async () => {
        for (const subscription of forwarding) {
          subscription.dispose();
        }
        const shown = view.visible;
        // The `when` clause hides the view once the context key names another spot; until then
        // it must not play on.
        view.webview.html = '';
        if (shown) {
          // Close the panel or sidebar that showed the video first. Otherwise the bottom panel
          // falls back to the Terminal view, which starts a shell and takes the focus (gate
          // round 1 of #49, CI run 43906351106), and the sidebar stays open and empty.
          await vscode.commands.executeCommand(closeCommands[spot]);
        }
      },
    };
    host.setTitle(title);
    forwarding.push(this.startPage(host));
    return host;
  }

  /** The player is gone (closed by the learner, or never opened): whatever it had loaded is gone. */
  private playerGone(): void {
    this.host = undefined;
    this.roots = [];
    void this.showSpot(undefined);
    this.closed.fire(undefined);
  }

  /**
   * Starts a new player page in `host`, and forwards what it posts while it is the player.
   * Returns the subscription, which the host disposes when it is dropped.
   */
  private startPage(host: Host): vscode.Disposable {
    const { webview } = host;
    webview.options = this.webviewOptions();
    const listening = webview.onDidReceiveMessage((raw: unknown) => {
      // A message already queued from a page dropped for a move is about a player that is gone.
      if (this.host !== host) {
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
    return listening;
  }

  private loadPage(): { readonly script: string; readonly style: string } {
    this.page ??= {
      script: readFileSync(join(this.extensionPath, 'out', 'player', 'player.js'), 'utf8'),
      style: readFileSync(join(this.extensionPath, 'out', 'player', 'player.css'), 'utf8'),
    };
    return this.page;
  }
}
