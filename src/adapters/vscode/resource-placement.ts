/**
 * Where a Resource tab opens (ADR 0012, orchestrator answer on story 94): never in the player's
 * editor group, so the video stays visible while the learner reads the file.
 *
 * In order:
 * 1. the group that already holds a Resource this window opened (a text, image or PDF tab, or one
 *    of FollowAlong's own Resource tabs), so Resources collect in one place
 *    (also when the learner's focus is in that group);
 * 2. else a group that is not the player's, not the active group and not the active editor's;
 * 3. else a new group at the end, which is to the right of the player in the usual
 *    code | player layout.
 * If the player is not in an editor group (other spots come later), VS Code's own `Beside`.
 */
import * as vscode from 'vscode';

import { isResourceViewType } from './resource-viewers.js';

export interface ResourcePlacement {
  /** The editor group column to open the next Resource in. */
  column(): vscode.ViewColumn;
  /** Notes that `path` was opened as a Resource, so the next one goes to the same group. */
  opened(path: string): void;
}

export function createResourcePlacement(
  playerColumn: () => vscode.ViewColumn | undefined,
): ResourcePlacement {
  /** Paths opened as Resources, in VS Code's own form (drive letter case on Windows). */
  const openedPaths = new Set<string>();

  return {
    column() {
      const player = playerColumn();
      if (player === undefined) {
        return vscode.ViewColumn.Beside;
      }
      const groups = vscode.window.tabGroups.all;
      const holdsResource = (group: vscode.TabGroup): boolean =>
        group.tabs.some(({ input }) => {
          if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
            return openedPaths.has(input.uri.fsPath);
          }
          return input instanceof vscode.TabInputWebview && isResourceViewType(input.viewType);
        });
      const withResources = groups.find(
        (group) => group.viewColumn !== player && holdsResource(group),
      );
      if (withResources !== undefined) {
        return withResources.viewColumn;
      }
      const inUse = new Set([
        player,
        vscode.window.tabGroups.activeTabGroup.viewColumn,
        vscode.window.activeTextEditor?.viewColumn,
      ]);
      const free = groups.find((group) => !inUse.has(group.viewColumn));
      // A number past the last group makes VS Code add a group there.
      return free?.viewColumn ?? groups.length + 1;
    },
    opened(path) {
      openedPaths.add(vscode.Uri.file(path).fsPath);
    },
  };
}
