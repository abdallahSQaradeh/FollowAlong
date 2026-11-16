/**
 * Forwards the learner's text edits to the core, as auto-pause's input (ADR 0052). It only
 * translates VS Code's event: which edits count is the core's decision.
 */
import * as vscode from 'vscode';

import type { DocumentEdit } from '../../core/auto-pause.js';

/** Calls `forward` with each change to the text of a document open in VS Code. */
export function watchDocumentEdits(forward: (edit: DocumentEdit) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((event) => {
    // An event with no change to the text (the document was saved, or its dirty state changed)
    // is not an edit. Cursor moves are another event, which this does not listen to.
    if (event.contentChanges.length === 0) {
      return;
    }
    const { uri } = event.document;
    forward({
      scheme: uri.scheme,
      ...(uri.scheme === 'file' ? { path: uri.fsPath } : {}),
      inActiveEditor: vscode.window.activeTextEditor?.document === event.document,
    });
  });
}
