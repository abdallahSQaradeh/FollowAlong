/**
 * The extension's entry point: builds the core from its ports and registers the commands.
 * Everything that decides something lives in the core (ADR 0002).
 */
import * as vscode from 'vscode';

import { createFollowAlong } from '../../core/follow-along.js';
import type { PlayerEvent } from '../../protocol/player-messages.js';
import { createSystemClock } from '../node/clock.js';
import { createUnavailableConverter } from '../node/converter.js';
import { createNodeFileSystem } from '../node/file-system.js';
import { FocusReturn } from './focus-return.js';
import { PlayerPanel } from './player-panel.js';
import { createConfig, createOutputLogger, createStorage, createUiSink } from './ports.js';

export const commands = {
  /** Temporary: opens a folder as the Course. The Course picker replaces the folder dialog. */
  openCourse: 'followalong.openCourse',
} as const;

/**
 * What `activate` returns when VS Code runs the extension's tests (`ExtensionMode.Test`): the
 * player events the extension received, so the smoke test can see the real page play a Lesson.
 * In normal use `activate` returns nothing.
 */
export interface TestHooks {
  readonly playerEvents: readonly PlayerEvent[];
}

export function activate(context: vscode.ExtensionContext): TestHooks | undefined {
  const channel = vscode.window.createOutputChannel('FollowAlong', { log: true });
  const logger = createOutputLogger(channel);
  const player = new PlayerPanel(context.extensionPath, logger);
  const focus = new FocusReturn();
  const core = createFollowAlong({
    player,
    fileSystem: createNodeFileSystem(),
    storage: createStorage(context),
    clock: createSystemClock(),
    converter: createUnavailableConverter(),
    config: createConfig(),
    ui: createUiSink(focus, logger),
    logger,
  });

  /** Runs a command, so an unexpected failure is logged and shown instead of lost. */
  const register = (id: string, run: (...args: unknown[]) => Promise<void>) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await run(...args);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        logger.log({ level: 'error', message: `${id} failed: ${message}` });
        void vscode.window.showErrorMessage(
          `FollowAlong: ${id} failed. See the FollowAlong output.`,
        );
      }
    });

  let testHooks: TestHooks | undefined;
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    const playerEvents: PlayerEvent[] = [];
    context.subscriptions.push(player.onEvent((event) => playerEvents.push(event)));
    testHooks = { playerEvents };
  }

  context.subscriptions.push(
    channel,
    player,
    focus,
    {
      dispose: () => {
        core.dispose();
      },
    },
    register(commands.openCourse, async (folder) => {
      const target =
        folder instanceof vscode.Uri
          ? folder
          : (
              await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Open Course',
                title: 'Open Course',
              })
            )?.[0];
      if (target !== undefined) {
        await core.openCourse(target.fsPath);
      }
    }),
  );
  return testHooks;
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
