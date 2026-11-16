/**
 * The extension's entry point: builds the core from its ports and registers the commands.
 * Everything that decides something lives in the core (ADR 0002).
 */
import * as vscode from 'vscode';

import { createFollowAlong } from '../../core/follow-along.js';
import { isStatusBarCommand } from '../../core/status-bar.js';
import { isVideoSpot } from '../../core/video-placement.js';
import type { PlayerEvent } from '../../protocol/player-messages.js';
import type { PdfViewerEvent } from '../../protocol/pdf-viewer-messages.js';
import { createSystemClock } from '../node/clock.js';
import { createFfmpegConverter } from '../node/converter.js';
import { createNodeFileSystem } from '../node/file-system.js';
import { courseNodeId, type LessonTreeModel } from '../../core/lesson-tree.js';
import { LessonTreeView, openResourceCommand, playLessonCommand } from './lesson-tree-view.js';
import { watchDocumentEdits } from './document-edits.js';
import { FocusReturn } from './focus-return.js';
import { PlayerPanel, type PlayerPlace } from './player-panel.js';
import { quickPickStats } from './quick-pick.js';
import { StatusBarView, type DrawnItem } from './status-bar-view.js';
import { createResourcePlacement } from './resource-placement.js';
import { ResourceViewers } from './resource-viewers.js';
import {
  createConfig,
  createOutputLogger,
  createStorage,
  createTerminalSettings,
  createUiSink,
  folderPath,
} from './ports.js';

/** The id of the tree node a context menu command was run with, if it was run with one. */
function nodeId(node: unknown): string | undefined {
  return typeof node === 'object' && node !== null && 'id' in node && typeof node.id === 'string'
    ? node.id
    : undefined;
}

export const commands = {
  /**
   * `Ctrl+'` `C`: the Course picker. Run with a folder's URI as its argument, it opens that folder
   * as the Course without the picker.
   */
  openCourse: 'followalong.openCourse',
  /** Run by a click on a Lesson in the tree, with the Lesson's id. */
  playLesson: playLessonCommand,
  /** The "+" on a Lesson in the tree; it is run with the Lesson's tree node. */
  attachResource: 'followalong.attachResource',
  /** `Ctrl+'` `A`: attaches a file to the Lesson that is playing. */
  attachToLoadedLesson: 'followalong.attachToLoadedLesson',
  /** Run by a click on a Resource in the tree, with the Resource's id. */
  openResource: openResourceCommand,
  /** The tree's context menu on a Resource; run with the Resource's tree node. */
  detachResource: 'followalong.detachResource',
  /** The tree's Relink… on a missing Resource; run with the Resource's tree node. */
  relinkResource: 'followalong.relinkResource',
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
  /** Run by a click on a status bar item, with the name of the core command the item names. */
  statusBarClick: 'followalong.statusBarClick',
  /** `Ctrl+'` `N` / `P`: the next or previous Lesson in Course order. */
  nextLesson: 'followalong.nextLesson',
  previousLesson: 'followalong.previousLesson',
  /** `Ctrl+'` `L`: the Lesson picker. */
  goToLesson: 'followalong.goToLesson',
  /** _Move video to…_: asks for a spot; run with a spot's name, moves the video there. */
  moveVideo: 'followalong.moveVideo',
  /** `Ctrl+'` `D`: marks the Lesson that is playing done, or not done when it already is. */
  toggleLessonDone: 'followalong.toggleLessonDone',
  /** The tree's context menu on a Lesson: Mark done, Mark not done; run with its tree node. */
  markLessonDone: 'followalong.markLessonDone',
  markLessonNotDone: 'followalong.markLessonNotDone',
  /** The tree's context menu on a Section: Mark all done, Reset Section; run with its tree node. */
  markSectionDone: 'followalong.markSectionDone',
  resetSection: 'followalong.resetSection',
  /** `FollowAlong: Reset Course progress`, from the Command Palette. */
  resetCourseProgress: 'followalong.resetCourseProgress',
} as const;

/**
 * What `activate` returns when VS Code runs the extension's tests (`ExtensionMode.Test`): the
 * player events the extension received, so the smoke test can see the real page play a Lesson,
 * and the Lesson the tree has selected.
 * In normal use `activate` returns nothing.
 */
export interface TestHooks {
  readonly playerEvents: readonly PlayerEvent[];
  /** What the PDF viewers reported, in order. */
  readonly pdfViewerEvents: readonly PdfViewerEvent[];
  /** The Lesson tree the learner sees now. */
  lessonTree(): LessonTreeModel;
  /** The status bar items VS Code shows now, with the command each one runs. */
  statusBar(): readonly DrawnItem[];
  /** The id of the Lesson the Lesson tree shows as selected. */
  selectedLesson(): string | undefined;
  /** How many quick picks (the Course picker, the Lesson picker) were shown so far. */
  quickPicksShown(): number;
  /** The label of the active (highlighted) item of the quick pick shown last, once it has one. */
  activeQuickPickItem(): string | undefined;
  /** The spot the player is in, and whether VS Code shows it; none while no player is open. */
  playerSpot(): PlayerPlace | undefined;
  /** Whether the quick pick shown last still shows its busy indicator: the core is still scanning. */
  quickPickBusy(): boolean;
}

/** Saves Progress when the window closes; set while the extension is active. */
let closeCore: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): TestHooks | undefined {
  const channel = vscode.window.createOutputChannel('FollowAlong', { log: true });
  const logger = createOutputLogger(channel);
  const focus = new FocusReturn();
  const player = new PlayerPanel(context.extensionPath, logger, () => focus.returnFocus());
  const lessonTree = new LessonTreeView(logger);
  const viewers = new ResourceViewers(context.extensionPath, logger);
  const statusBar = new StatusBarView(commands.statusBarClick);
  const core = createFollowAlong({
    player,
    fileSystem: createNodeFileSystem(),
    storage: createStorage(context),
    clock: createSystemClock(),
    converter: createFfmpegConverter(),
    config: createConfig(),
    ui: createUiSink(
      lessonTree,
      statusBar,
      createResourcePlacement(() => player.viewColumn),
      viewers,
      focus,
      logger,
    ),
    logger,
    terminalSettings: createTerminalSettings(),
  });

  closeCore = () => core.close();

  /** Logs an unexpected failure and shows it, instead of losing it. */
  const report = (what: string, error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logger.log({ level: 'error', message: `${what} failed: ${message}` });
    void vscode.window.showErrorMessage(`FollowAlong: ${what} failed. See the FollowAlong output.`);
  };

  /** Runs a command, so an unexpected failure is logged and shown instead of lost. */
  const register = (id: string, run: (...args: unknown[]) => void | Promise<void>) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await run(...args);
      } catch (error) {
        report(id, error);
      }
    });

  let testHooks: TestHooks | undefined;
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    const playerEvents: PlayerEvent[] = [];
    const pdfViewerEvents: PdfViewerEvent[] = [];
    context.subscriptions.push(
      player.onEvent((event) => playerEvents.push(event)),
      viewers.onPdfEvent((event) => pdfViewerEvents.push(event)),
    );
    testHooks = {
      playerEvents,
      pdfViewerEvents,
      lessonTree: () => lessonTree.current,
      statusBar: () => statusBar.drawn(),
      selectedLesson: () => lessonTree.selectedLesson(),
      quickPicksShown: () => quickPickStats.shown,
      activeQuickPickItem: () => quickPickStats.active,
      playerSpot: () => player.place,
      quickPickBusy: () => quickPickStats.busy,
    };
  }

  context.subscriptions.push(
    channel,
    player,
    viewers,
    lessonTree,
    statusBar,
    focus,
    {
      dispose: () => {
        core.dispose();
      },
    },
    // Auto-pause's input: the learner's edits (ADR 0052).
    watchDocumentEdits((edit) => {
      core.documentEdited(edit);
    }),
    register(commands.openCourse, (folder) =>
      folder instanceof vscode.Uri ? core.openCourse(folderPath(folder)) : core.pickCourse(),
    ),
    register(commands.attachResource, async (node, file) => {
      const nodeKey = nodeId(node);
      if (nodeKey === undefined) {
        return;
      }
      const path = file instanceof vscode.Uri ? file.fsPath : undefined;
      // Without a file the core asks for one, so it fixes the Course (and Lesson) first (ADR 0024).
      await (nodeKey === courseNodeId
        ? core.attachCourseResource(path)
        : core.attachResource(nodeKey, path));
    }),
    register(commands.attachToLoadedLesson, async () => {
      await core.attachToLoadedLesson();
    }),
    register(commands.detachResource, async (node) => {
      const resourceId = nodeId(node);
      if (resourceId !== undefined) {
        await core.detachResource(resourceId);
      }
    }),
    register(commands.relinkResource, async (node) => {
      const resourceId = nodeId(node);
      if (resourceId !== undefined) {
        // The core asks for the file, so it fixes the Resource's Course first (ADR 0024).
        await core.relinkResource(resourceId);
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
    register(commands.statusBarClick, (command) => {
      if (isStatusBarCommand(command)) {
        core.statusBarClick(command);
      }
    }),
    register(commands.nextLesson, () => {
      core.nextLesson();
    }),
    register(commands.previousLesson, () => {
      core.previousLesson();
    }),
    register(commands.goToLesson, () => core.goToLesson()),
    register(commands.moveVideo, (spot) => core.moveVideo(isVideoSpot(spot) ? spot : undefined)),
    register(commands.toggleLessonDone, () => core.toggleLessonDone()),
    register(commands.markLessonDone, async (node) => {
      const lessonId = nodeId(node);
      if (lessonId !== undefined) {
        await core.markLessonDone(lessonId);
      }
    }),
    register(commands.markLessonNotDone, async (node) => {
      const lessonId = nodeId(node);
      if (lessonId !== undefined) {
        await core.markLessonNotDone(lessonId);
      }
    }),
    register(commands.markSectionDone, async (node) => {
      const sectionId = nodeId(node);
      if (sectionId !== undefined) {
        await core.markSectionDone(sectionId);
      }
    }),
    register(commands.resetSection, async (node) => {
      const sectionId = nodeId(node);
      if (sectionId !== undefined) {
        await core.resetSection(sectionId);
      }
    }),
    register(commands.resetCourseProgress, () => core.resetCourseProgress()),
  );
  // Reopening the workspace brings back the Course that was open in it (story 21).
  core.restoreCourse().catch((error: unknown) => {
    report('Reopening the Course', error);
  });
  return testHooks;
}

/** VS Code waits for the returned promise (a few seconds at most) before the window closes. */
export function deactivate(): Promise<void> | undefined {
  const close = closeCore;
  closeCore = undefined;
  // Everything else is disposed through context.subscriptions.
  return close?.();
}
