/**
 * The playback items in the status bar. It only draws the view model the core hands to the UI
 * sink; a click runs the command the model names.
 */
import * as vscode from 'vscode';

import {
  statusBarItemOrder,
  type StatusBarIcon,
  type StatusBarMarker,
  type StatusBarItemId,
  type StatusBarItemModel,
  type StatusBarModel,
} from '../../core/status-bar.js';

/** An item as VS Code has it: for the smoke test to read. */
export interface DrawnItem {
  readonly id: StatusBarItemId;
  /** With the icon as `$(name)`. */
  readonly text: string;
  /** The VS Code command a click runs, and the core command it is run with. */
  readonly command: { readonly id: string; readonly argument: unknown } | undefined;
  /** VS Code draws a higher priority further left. */
  readonly priority: number | undefined;
}

const codicons: Readonly<Record<StatusBarIcon, string>> = {
  play: 'play',
  pause: 'debug-pause',
  back: 'debug-step-back',
  zoom: 'zoom-in',
  sound: 'sync~spin',
};

/**
 * Where an item sits: VS Code draws a higher priority further left, and sets it only when it makes
 * the item. Each id has a place of its own in the core's order, so an item that comes later (sound,
 * zoom) never ties with or lands left of one already shown (final review of #12).
 */
function priorityOf(id: StatusBarItemId): number {
  return statusBarItemOrder.length - statusBarItemOrder.indexOf(id);
}

const markerCodicons: Readonly<Record<StatusBarMarker, string>> = {
  autoPause: 'keyboard',
};

export class StatusBarView implements vscode.Disposable {
  private readonly items = new Map<StatusBarItemId, vscode.StatusBarItem>();
  /** The items as VS Code has them now: what the learner sees, and what a click runs. */
  drawn(): readonly DrawnItem[] {
    return [...this.items]
      .sort(([a], [b]) => priorityOf(b) - priorityOf(a))
      .map(([id, item]): DrawnItem => {
        const { command } = item;
        const argument: unknown = typeof command === 'object' ? command.arguments?.[0] : undefined;
        return {
          id,
          text: item.text,
          command: typeof command === 'object' ? { id: command.command, argument } : undefined,
          priority: item.priority,
        };
      });
  }

  /** `clickCommand` is run with the name of the core command, whenever an item is clicked. */
  constructor(private readonly clickCommand: string) {}

  show(model: StatusBarModel): void {
    const shown = new Set(model.items.map((item) => item.id));
    for (const [id, item] of this.items) {
      if (!shown.has(id)) {
        item.dispose();
        this.items.delete(id);
      }
    }
    for (const item of model.items) {
      this.draw(item);
    }
  }

  private draw(model: StatusBarItemModel): void {
    let item = this.items.get(model.id);
    if (item === undefined) {
      item = vscode.window.createStatusBarItem(
        `followalong.${model.id}`,
        vscode.StatusBarAlignment.Left,
        priorityOf(model.id),
      );
      item.name = `FollowAlong: ${model.id}`;
      this.items.set(model.id, item);
    }
    item.text = [
      model.icon === undefined ? '' : `$(${codicons[model.icon]})`,
      model.marker === undefined ? '' : `$(${markerCodicons[model.marker]})`,
      model.text,
    ]
      .filter((part) => part !== '')
      .join(' ');
    item.tooltip = model.tooltip;
    item.accessibilityInformation = { label: model.tooltip, role: 'button' };
    item.command =
      model.command === undefined
        ? undefined
        : { command: this.clickCommand, title: model.tooltip, arguments: [model.command] };
    item.show();
  }

  dispose(): void {
    for (const item of this.items.values()) {
      item.dispose();
    }
    this.items.clear();
  }
}
