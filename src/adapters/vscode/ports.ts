/**
 * Thin VS Code adapters for the Storage, Config, UI sink and Logger ports.
 */
import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import type { Config, KeyValueStore, Storage, UiSink } from '../../core/ports.js';
import type { LessonTreeView } from './lesson-tree-view.js';
import type { ResourcePlacement } from './resource-placement.js';
import type { StatusBarView } from './status-bar-view.js';
import { showQuickPick } from './quick-pick.js';

function store(memento: vscode.Memento): KeyValueStore {
  return {
    get: (key) => memento.get<unknown>(key),
    set: (key, value) => Promise.resolve(memento.update(key, value)),
  };
}

export function createStorage(context: vscode.ExtensionContext): Storage {
  return {
    global: store(context.globalState),
    workspace: store(context.workspaceState),
    folder: context.globalStorageUri.fsPath,
  };
}

export function createConfig(): Config {
  return {
    get: (name) => vscode.workspace.getConfiguration('followalong').get<unknown>(name),
    onDidChange: (listener) =>
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('followalong')) {
          listener((name) => event.affectsConfiguration(`followalong.${name}`));
        }
      }),
  };
}

export function createUiSink(
  tree: LessonTreeView,
  statusBar: StatusBarView,
  placement: ResourcePlacement,
): UiSink {
  return {
    showMessage({ severity, text }) {
      const show = {
        info: vscode.window.showInformationMessage,
        warning: vscode.window.showWarningMessage,
        error: vscode.window.showErrorMessage,
      }[severity];
      void show(text);
    },
    pick: showQuickPick,
    showLessonTree(model) {
      tree.show(model);
    },
    showStatusBar(model) {
      statusBar.show(model);
    },
    async openResource(target) {
      // VS Code picks the editor for the file (text and code in the text editor). The group is
      // never the player's, so the video stays in sight, and focus stays where it was.
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.path), {
        viewColumn: placement.column(),
        preview: false,
        preserveFocus: true,
      });
      placement.opened(target.path);
    },
  };
}

/** Writes the core's log to the "FollowAlong" output channel. */
export function createOutputLogger(channel: vscode.LogOutputChannel): Logger {
  return {
    log({ level, message }) {
      channel[level](message);
    },
  };
}
