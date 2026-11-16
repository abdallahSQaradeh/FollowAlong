/**
 * The Resource opener port as VS Code's own `vscode.open`: the file opens in the editor group
 * beside the code, in the editor VS Code picks for it (text and code in the text editor).
 * The player is retained while another tab is in front, so the Lesson keeps playing.
 */
import * as vscode from 'vscode';

import type { ResourceOpener } from '../../core/ports.js';

export function createResourceOpener(): ResourceOpener {
  return {
    async openFile(absolutePath) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolutePath), {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
    },
  };
}
