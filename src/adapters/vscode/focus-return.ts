/**
 * Remembers whether the learner last used a text editor or a terminal, and hands keyboard focus
 * back to it when the core asks (ADR 0007). The stable VS Code API cannot read which part has
 * focus, so this follows the signals it does give: an editor becoming active, a selection change
 * or an edit in an editor; a terminal becoming active, a command starting in it, or the first
 * input to it.
 */
import * as vscode from 'vscode';

type FocusTarget =
  | {
      readonly kind: 'editor';
      readonly document: vscode.TextDocument;
      readonly viewColumn: vscode.ViewColumn | undefined;
    }
  | { readonly kind: 'terminal'; readonly terminal: vscode.Terminal };

/** Only real files and untitled documents: not output channels, settings or other panels. */
function isCode(editor: vscode.TextEditor): boolean {
  const { scheme } = editor.document.uri;
  return scheme === 'file' || scheme === 'untitled';
}

export class FocusReturn implements vscode.Disposable {
  private target: FocusTarget | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    const { window, workspace } = vscode;
    const editor = window.activeTextEditor;
    if (editor !== undefined) {
      this.useEditor(editor);
    }
    this.subscriptions = [
      // `undefined` when a non-text editor such as the player becomes active: keep the target.
      window.onDidChangeActiveTextEditor((active) => {
        if (active !== undefined) {
          this.useEditor(active);
        }
      }),
      window.onDidChangeTextEditorSelection(({ textEditor }) => {
        this.useEditor(textEditor);
      }),
      workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        const active = window.activeTextEditor;
        if (contentChanges.length > 0 && active?.document === document) {
          this.useEditor(active);
        }
      }),
      window.onDidChangeActiveTerminal((terminal) => {
        if (terminal !== undefined) {
          this.useTerminal(terminal);
        }
      }),
      window.onDidStartTerminalShellExecution(({ terminal }) => {
        this.useTerminal(terminal);
      }),
      window.onDidChangeTerminalState((terminal) => {
        if (terminal.state.isInteractedWith) {
          this.useTerminal(terminal);
        }
      }),
      window.onDidCloseTerminal((terminal) => {
        if (this.target?.kind === 'terminal' && this.target.terminal === terminal) {
          this.target = undefined;
        }
      }),
    ];
  }

  /**
   * Focuses the editor or terminal used last. An editor only while it is still visible, so a tab
   * behind the player is never brought in front of it.
   */
  async returnFocus(): Promise<void> {
    const target = this.target;
    if (target?.kind === 'terminal') {
      target.terminal.show(false);
      return;
    }
    if (target === undefined) {
      return;
    }
    const visible = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document === target.document,
    );
    const editor =
      visible.find((candidate) => candidate.viewColumn === target.viewColumn) ?? visible[0];
    if (editor !== undefined) {
      await vscode.window.showTextDocument(editor.document, {
        ...(editor.viewColumn === undefined ? {} : { viewColumn: editor.viewColumn }),
        preserveFocus: false,
      });
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private useEditor(editor: vscode.TextEditor): void {
    if (isCode(editor)) {
      this.target = { kind: 'editor', document: editor.document, viewColumn: editor.viewColumn };
    }
  }

  private useTerminal(terminal: vscode.Terminal): void {
    this.target = { kind: 'terminal', terminal };
  }
}
