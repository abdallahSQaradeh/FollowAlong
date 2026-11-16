/**
 * The FollowAlong tree view in the activity bar. It only draws the view model the core hands to
 * the UI sink; a click on a Lesson runs `followalong.playLesson` with the Lesson's id.
 */
import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';
import type { CourseNode, LessonTreeModel, LessonTreeNode } from '../../core/lesson-tree.js';

export const lessonTreeViewId = 'followalong.lessons';
export const playLessonCommand = 'followalong.playLesson';
export const openResourceCommand = 'followalong.openResource';
/** The scheme of the `resourceUri` of a missing Resource: the decoration below dims such rows. */
const missingScheme = 'followalong-missing';

/** Any node of the tree: the Course node at its top, or a node of the Course below it. */
type TreeNode = CourseNode | LessonTreeNode;

/** The top of the tree: the Course node (with the Course's Resources), then the Course's nodes. */
function rootsOf(model: LessonTreeModel): readonly TreeNode[] {
  return model.course === undefined ? model.nodes : [model.course, ...model.nodes];
}

/**
 * What VS Code shows under a node: a Course's Resources, a Section's Lessons and Sections, a
 * Lesson's Resources.
 */
function childrenOf(node: TreeNode): readonly TreeNode[] {
  switch (node.kind) {
    case 'course':
      return node.resources;
    case 'section':
      return node.children;
    case 'lesson':
      return node.resources;
    case 'resource':
      return [];
  }
}

/** The nodes from the top of the tree down to the node with this id, or none if it is not there. */
function pathTo(nodes: readonly TreeNode[], id: string): TreeNode[] {
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

export class LessonTreeView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private model: LessonTreeModel = { nodes: [] };
  /** The tree as the learner sees it now (the smoke test reads it). */
  get current(): LessonTreeModel {
    return this.model;
  }

  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly view: vscode.TreeView<TreeNode>;
  private readonly subscription: vscode.Disposable;
  /** Dims the label of a Resource whose file is missing, as VS Code dims a disabled item. */
  private readonly dimming: vscode.Disposable;
  /** The Lesson the core last asked to select. */
  private selectedLessonId: string | undefined;
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly logger: Logger) {
    this.view = vscode.window.createTreeView(lessonTreeViewId, { treeDataProvider: this });
    this.dimming = vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) =>
        uri.scheme === missingScheme
          ? new vscode.FileDecoration(
              undefined,
              'The file is missing',
              new vscode.ThemeColor('disabledForeground'),
            )
          : undefined,
    });
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
    if (this.selectedLessonId === undefined || !this.view.visible) {
      return;
    }
    const node = pathTo(rootsOf(this.model), this.selectedLessonId).at(-1);
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

  getParent(node: TreeNode): TreeNode | undefined {
    return pathTo(rootsOf(this.model), node.id).at(-2);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node === undefined) {
      return [...rootsOf(this.model)];
    }
    return [...childrenOf(node)];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'course') {
      // Open when it has Resources, so the cheat sheet just attached is in sight.
      const item = new vscode.TreeItem(
        node.label,
        node.resources.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.id = node.id;
      item.contextValue = 'course';
      item.iconPath = new vscode.ThemeIcon('book');
      return item;
    }
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.id;
      item.contextValue = 'section';
      return item;
    }
    if (node.kind === 'resource' && node.type === 'url') {
      // A web page has no file to lose: never dimmed, and no Relink… (ADR 0047).
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.tooltip = node.path;
      item.contextValue = 'resourceUrl';
      item.iconPath = new vscode.ThemeIcon('globe');
      item.command = { command: openResourceCommand, title: 'Open Resource', arguments: [node.id] };
      return item;
    }
    if (node.kind === 'resource') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.tooltip = node.missing
        ? `${node.path}\nThe file is missing. Use Relink… to point it at its new place.`
        : node.path;
      // A missing file shows dimmed, and only then offers Relink… (story 97).
      item.contextValue = node.missing ? 'resourceMissing' : 'resource';
      if (node.missing) {
        item.description = 'missing';
      }
      item.resourceUri = node.missing
        ? vscode.Uri.file(node.path).with({ scheme: missingScheme })
        : vscode.Uri.file(node.path);
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
    this.subscription.dispose();
    this.dimming.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}
