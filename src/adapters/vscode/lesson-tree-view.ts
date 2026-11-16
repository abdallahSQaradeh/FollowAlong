/**
 * The FollowAlong tree view in the activity bar. It only draws the view model the core hands to
 * the UI sink; a click on a Lesson runs `followalong.playLesson` with the Lesson's id.
 */
import * as vscode from 'vscode';

import type { LessonTreeModel, LessonTreeNode } from '../../core/lesson-tree.js';

export const lessonTreeViewId = 'followalong.lessons';
export const playLessonCommand = 'followalong.playLesson';
export const openResourceCommand = 'followalong.openResource';

export class LessonTreeView implements vscode.TreeDataProvider<LessonTreeNode>, vscode.Disposable {
  private model: LessonTreeModel = { nodes: [] };
  /** The tree as the learner sees it now (the smoke test reads it). */
  get current(): LessonTreeModel {
    return this.model;
  }

  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly view: vscode.TreeView<LessonTreeNode>;
  readonly onDidChangeTreeData = this.changed.event;

  constructor() {
    this.view = vscode.window.createTreeView(lessonTreeViewId, { treeDataProvider: this });
  }

  show(model: LessonTreeModel): void {
    this.model = model;
    this.view.message = model.message ?? '';
    this.changed.fire(undefined);
  }

  getChildren(node?: LessonTreeNode): LessonTreeNode[] {
    if (node === undefined) {
      return [...this.model.nodes];
    }
    switch (node.kind) {
      case 'section':
        return [...node.children];
      case 'lesson':
        return [...node.resources];
      case 'resource':
        return [];
    }
  }

  getTreeItem(node: LessonTreeNode): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.id;
      item.contextValue = 'section';
      return item;
    }
    if (node.kind === 'resource') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.contextValue = 'resource';
      item.tooltip = node.path;
      item.resourceUri = vscode.Uri.file(node.path);
      item.command = { command: openResourceCommand, title: 'Open Resource', arguments: [node.id] };
      return item;
    }
    // A Lesson with Resources opens expanded, so a file the learner just attached is in sight.
    const item = new vscode.TreeItem(
      node.label,
      node.resources.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.contextValue = 'lesson';
    item.iconPath = new vscode.ThemeIcon('play-circle');
    item.command = { command: playLessonCommand, title: 'Play Lesson', arguments: [node.id] };
    return item;
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}
