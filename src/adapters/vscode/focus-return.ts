/**
 * Remembers whether the learner last used a text editor or a terminal, and hands keyboard focus
 * back to it when the core asks (ADR 0009). The stable VS Code API cannot read which part has
 * focus, so this follows the signals it does give: an editor becoming active or the learner
 * moving its selection (keyboard, mouse or a command); a terminal becoming active, a command
 * starting in it, or the first input to it. Changes from outside, such as a file reloaded after a
 * `git checkout` run in the terminal, carry no selection kind and move nothing.
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

/** What a focus return handed the focus to: an editor, a terminal, or nothing (none in sight). */
export type FocusedPart = 'editor' | 'terminal' | 'none';

export class FocusReturn implements vscode.Disposable {
  private target: FocusTarget | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    const { window } = vscode;
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
      // Typing moves the selection too, so this also covers the learner's edits. `kind` is unset
      // when the change did not come from the learner's keyboard, mouse or a command.
      window.onDidChangeTextEditorSelection(({ textEditor, kind }) => {
        if (kind !== undefined) {
          this.useEditor(textEditor);
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
   * behind the player is never brought in front of it; otherwise any visible code editor, so focus
   * does not stay in the player. With no code editor in sight, focus stays where it is.
   * Resolves with what got the focus.
   */
  async returnFocus(): Promise<FocusedPart> {
    const target = this.target;
    if (target?.kind === 'terminal') {
      target.terminal.show(false);
      return 'terminal';
    }
    const visible = vscode.window.visibleTextEditors.filter(isCode);
    const editor =
      visible.find(
        (candidate) =>
          candidate.document === target?.document && candidate.viewColumn === target.viewColumn,
      ) ??
      visible.find((candidate) => candidate.document === target?.document) ??
      visible[0];
    if (editor !== undefined) {
      await vscode.window.showTextDocument(editor.document, {
        ...(editor.viewColumn === undefined ? {} : { viewColumn: editor.viewColumn }),
        preserveFocus: false,
      });
      return 'editor';
    }
    return 'none';
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
