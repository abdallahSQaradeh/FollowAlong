/**
 * The FollowAlong tree view in the activity bar. It only draws the view model the core hands to
 * the UI sink; a click on a Lesson runs `followalong.playLesson` with the Lesson's id.
 */
import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import type { LessonTreeModel, LessonTreeNode } from '../../core/lesson-tree.js';

export const lessonTreeViewId = 'followalong.lessons';
export const playLessonCommand = 'followalong.playLesson';
export const openResourceCommand = 'followalong.openResource';

/** What VS Code shows under a node: a Section's Lessons and Sections, a Lesson's Resources. */
function childrenOf(node: LessonTreeNode): readonly LessonTreeNode[] {
  switch (node.kind) {
    case 'section':
      return node.children;
    case 'lesson':
      return node.resources;
    case 'resource':
      return [];
  }
}

/** The nodes from the top of the tree down to the node with this id, or none if it is not there. */
function pathTo(nodes: readonly LessonTreeNode[], id: string): LessonTreeNode[] {
  for (const node of nodes) {
    if (node.id === id) {
      return [node];
    }
    const inside = pathTo(childrenOf(node), id);
    if (inside.length > 0) {
      return [node, ...inside];
    }
  }
  return [];
}

export class LessonTreeView implements vscode.TreeDataProvider<LessonTreeNode>, vscode.Disposable {
  private model: LessonTreeModel = { nodes: [] };
  /** The tree as the learner sees it now (the smoke test reads it). */
  get current(): LessonTreeModel {
    return this.model;
  }

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
    // The Course's done/total and percent sit beside the view's title.
    this.view.description = model.summary?.description ?? '';
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
    if (this.selectedLessonId === undefined || !this.view.visible) {
      return;
    }
    const node = pathTo(this.model.nodes, this.selectedLessonId).at(-1);
    if (node === undefined) {
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
    return [...childrenOf(node)];
  }

  getTreeItem(node: LessonTreeNode): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.id;
      item.contextValue = 'section';
      item.description = node.description;
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
    // The state mark leads the label: ✓ done, ◐ in progress, ○ not started.
    item.label = `${node.glyph} ${node.label}`;
    item.description = node.description;
    item.command = { command: playLessonCommand, title: 'Play Lesson', arguments: [node.id] };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}
