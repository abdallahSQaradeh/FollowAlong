/**
 * Thin VS Code adapters for the Storage, Config, UI sink and Logger ports.
 */
import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import type { Config, KeyValueStore, Storage, UiSink } from '../../core/ports.js';

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

export function createUiSink(): UiSink {
  return {
    showMessage({ severity, text }) {
      const show = {
        info: vscode.window.showInformationMessage,
        warning: vscode.window.showWarningMessage,
        error: vscode.window.showErrorMessage,
      }[severity];
      void show(text);
    },
    showLessonTree() {
      // The tree view arrives with the next edit in this slice.
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
