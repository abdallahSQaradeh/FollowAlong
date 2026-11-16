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
import type { LessonTreeModel } from '../../core/lesson-tree.js';
import { LessonTreeView, openResourceCommand, playLessonCommand } from './lesson-tree-view.js';
import { PlayerPanel } from './player-panel.js';
import { createResourcePlacement } from './resource-placement.js';
import { createConfig, createOutputLogger, createStorage, createUiSink } from './ports.js';

export const commands = {
  /** Temporary: opens a folder as the Course. The Course picker replaces the folder dialog. */
  openCourse: 'followalong.openCourse',
  /** Run by a click on a Lesson in the tree, with the Lesson's id. */
  playLesson: playLessonCommand,
  /** The "+" on a Lesson in the tree; it is run with the Lesson's tree node. */
  attachResource: 'followalong.attachResource',
  /** Run by a click on a Resource in the tree, with the Resource's id. */
  openResource: openResourceCommand,
  /** A playback controller command: command in, player message out. Bound to keys in package.json. */
  playPause: 'followalong.playPause',
  /** The step commands; their sizes are the `followalong.shortStep` and `longStep` settings. */
  seekBackShort: 'followalong.seekBackShort',
  seekForwardShort: 'followalong.seekForwardShort',
  seekBackLong: 'followalong.seekBackLong',
  seekForwardLong: 'followalong.seekForwardLong',
  /** `Ctrl+'` `↑` / `↓`: one rung up or down the speed ladder. */
  speedUp: 'followalong.speedUp',
  speedDown: 'followalong.speedDown',
  /** `Ctrl+'` `N` / `P`: the next or previous Lesson in Course order. */
  nextLesson: 'followalong.nextLesson',
  previousLesson: 'followalong.previousLesson',
  /** `Ctrl+'` `L`: the Lesson picker. */
  goToLesson: 'followalong.goToLesson',
} as const;

/**
 * What `activate` returns when VS Code runs the extension's tests (`ExtensionMode.Test`): the
 * player events the extension received, so the smoke test can see the real page play a Lesson,
 * and the Lesson the tree has selected.
 * In normal use `activate` returns nothing.
 */
export interface TestHooks {
  readonly playerEvents: readonly PlayerEvent[];
  /** The Lesson tree the learner sees now. */
  lessonTree(): LessonTreeModel;
  /** The id of the Lesson the Lesson tree shows as selected. */
  selectedLesson(): string | undefined;
}

export function activate(context: vscode.ExtensionContext): TestHooks | undefined {
  const channel = vscode.window.createOutputChannel('FollowAlong', { log: true });
  const logger = createOutputLogger(channel);
  const player = new PlayerPanel(context.extensionPath, logger);
  const lessonTree = new LessonTreeView(logger);
  const core = createFollowAlong({
    player,
    fileSystem: createNodeFileSystem(),
    storage: createStorage(context),
    clock: createSystemClock(),
    converter: createUnavailableConverter(),
    config: createConfig(),
    ui: createUiSink(
      lessonTree,
      createResourcePlacement(() => player.viewColumn),
    ),
    logger,
  });

  /** Runs a command, so an unexpected failure is logged and shown instead of lost. */
  const register = (id: string, run: (...args: unknown[]) => void | Promise<void>) =>
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
    testHooks = {
      playerEvents,
      lessonTree: () => lessonTree.current,
      selectedLesson: () => lessonTree.selectedLesson(),
    };
  }

  context.subscriptions.push(
    channel,
    player,
    lessonTree,
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
    register(commands.attachResource, async (node, file) => {
      const lessonId =
        typeof node === 'object' && node !== null && 'id' in node ? node.id : undefined;
      if (typeof lessonId !== 'string') {
        return;
      }
      const target =
        file instanceof vscode.Uri
          ? file
          : (
              await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Attach',
                title: 'Attach a file to this Lesson',
              })
            )?.[0];
      if (target !== undefined) {
        await core.attachResource(lessonId, target.fsPath);
      }
    }),
    register(commands.openResource, async (resourceId) => {
      if (typeof resourceId === 'string') {
        await core.openResource(resourceId);
      }
    }),
    register(commands.playLesson, (lessonId) => {
      if (typeof lessonId === 'string') {
        core.playLesson(lessonId);
      }
      return Promise.resolve();
    }),
    register(commands.playPause, () => {
      core.playPause();
    }),
    register(commands.seekBackShort, () => {
      core.seekStep('short', 'back');
    }),
    register(commands.seekForwardShort, () => {
      core.seekStep('short', 'forward');
    }),
    register(commands.seekBackLong, () => {
      core.seekStep('long', 'back');
    }),
    register(commands.seekForwardLong, () => {
      core.seekStep('long', 'forward');
    }),
    register(commands.speedUp, () => {
      core.speedStep('up');
    }),
    register(commands.speedDown, () => {
      core.speedStep('down');
    }),
    register(commands.nextLesson, () => {
      core.nextLesson();
    }),
    register(commands.previousLesson, () => {
      core.previousLesson();
    }),
    register(commands.goToLesson, () => core.goToLesson()),
  );
  return testHooks;
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
