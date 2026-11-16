/**
 * The FollowAlong tree view in the activity bar. It only draws the view model the core hands to
 * the UI sink; a click on a Lesson runs `followalong.playLesson` with the Lesson's id.
 */
import * as vscode from 'vscode';

import type { LessonTreeModel, LessonTreeNode } from '../../core/lesson-tree.js';

export const lessonTreeViewId = 'followalong.lessons';
export const playLessonCommand = 'followalong.playLesson';

/** The node with this id, anywhere in the tree. */
function findNode(nodes: readonly LessonTreeNode[], id: string): LessonTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const inside = node.kind === 'section' ? findNode(node.children, id) : undefined;
    if (inside !== undefined) {
      return inside;
    }
  }
  return undefined;
}

/** The Section that holds `target`, or undefined for a node at the top. */
function findParent(
  nodes: readonly LessonTreeNode[],
  target: LessonTreeNode,
  parent?: LessonTreeNode,
): LessonTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === target.id) {
      return parent;
    }
    const inside = node.kind === 'section' ? findParent(node.children, target, node) : undefined;
    if (inside !== undefined) {
      return inside;
    }
  }
  return undefined;
}

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

  /** Selects the Lesson and scrolls it into view, without taking focus from the code. */
  select(lessonId: string): void {
    const node = findNode(this.model.nodes, lessonId);
    if (node !== undefined) {
      void this.view.reveal(node, { select: true, focus: false, expand: true });
    }
  }

  getParent(node: LessonTreeNode): LessonTreeNode | undefined {
    return findParent(this.model.nodes, node);
  }

  getChildren(node?: LessonTreeNode): LessonTreeNode[] {
    if (node === undefined) {
      return [...this.model.nodes];
    }
    return node.kind === 'section' ? [...node.children] : [];
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
