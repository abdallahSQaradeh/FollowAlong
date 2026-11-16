/**
 * The FollowAlong tree view in the activity bar. It only draws the view model the core hands to
 * the UI sink; a click on a Lesson runs `followalong.playLesson` with the Lesson's id.
 */
import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import type { LessonTreeModel, LessonTreeNode } from '../../core/lesson-tree.js';

export const lessonTreeViewId = 'followalong.lessons';
export const playLessonCommand = 'followalong.playLesson';

/** The nodes from the top of the tree down to the node with this id, or none if it is not there. */
function pathTo(nodes: readonly LessonTreeNode[], id: string): LessonTreeNode[] {
  for (const node of nodes) {
    if (node.id === id) {
      return [node];
    }
    const inside = node.kind === 'section' ? pathTo(node.children, id) : [];
    if (inside.length > 0) {
      return [node, ...inside];
    }
  }
  return [];
}

export class LessonTreeView implements vscode.TreeDataProvider<LessonTreeNode>, vscode.Disposable {
  private model: LessonTreeModel = { nodes: [] };
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly view: vscode.TreeView<LessonTreeNode>;
  private readonly subscription: vscode.Disposable;
  /** The Lesson the core last asked to select. */
  private selectedLessonId: string | undefined;
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly logger: Logger) {
    this.view = vscode.window.createTreeView(lessonTreeViewId, { treeDataProvider: this });
    this.subscription = this.view.onDidChangeVisibility((event) => {
      if (event.visible) {
        this.revealSelected();
      }
    });
  }

  show(model: LessonTreeModel): void {
    this.model = model;
    this.view.message = model.message ?? '';
    this.changed.fire(undefined);
  }

  /**
   * Selects the Lesson and scrolls it into view, without taking focus from the code. A view that
   * is not on screen cannot select anything, so the Lesson is kept and selected when it appears.
   */
  select(lessonId: string): void {
    this.selectedLessonId = lessonId;
    this.revealSelected();
  }

  /** The id of the Lesson the tree shows as selected, for the smoke test. */
  selectedLesson(): string | undefined {
    return this.view.selection[0]?.id;
  }

  private revealSelected(): void {
    const node = pathTo(this.model.nodes, this.selectedLessonId ?? '').at(-1);
    if (node === undefined || !this.view.visible) {
      return;
    }
    this.view
      .reveal(node, { select: true, focus: false, expand: true })
      .then(undefined, (error: unknown) => {
        this.logger.log({
          level: 'warn',
          message: `Could not select ${node.id} in the Lesson tree: ${String(error)}`,
        });
      });
  }

  getParent(node: LessonTreeNode): LessonTreeNode | undefined {
    return pathTo(this.model.nodes, node.id).at(-2);
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
    this.subscription.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}
