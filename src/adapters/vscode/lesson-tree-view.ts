/**
 * The FollowAlong tree view in the activity bar. It only draws the view model the core hands to
 * the UI sink; a click on a Lesson runs `followalong.playLesson` with the Lesson's id.
 */
import * as vscode from 'vscode';

import type { LessonTreeModel, LessonTreeNode } from '../../core/lesson-tree.js';

export const lessonTreeViewId = 'followalong.lessons';
export const playLessonCommand = 'followalong.playLesson';

export class LessonTreeView implements vscode.TreeDataProvider<LessonTreeNode>, vscode.Disposable {
  private model: LessonTreeModel = { nodes: [] };
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
    return [...(node === undefined ? this.model.nodes : (node.children ?? []))];
  }

  getTreeItem(node: LessonTreeNode): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.id;
      item.contextValue = 'section';
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
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
