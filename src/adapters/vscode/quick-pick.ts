/**
 * The VS Code adapter for the core's quick-pick view models. It knows nothing of any one picker:
 * it draws a {@link QuickPickModel} and answers with the intent of the item the learner picked.
 * The Lesson picker and the Course picker both use it.
 */
import * as vscode from 'vscode';

import type { LivePicker } from '../../core/ports.js';
import type { QuickPickButtonModel, QuickPickModel } from '../../core/quick-pick.js';

/**
 * What the smoke test can see of the quick picks, so it never guesses how long the scan takes or
 * where the focus is: how many were shown, the label of the active item of the latest, and
 * whether the latest still shows its busy indicator.
 */
export const quickPickStats: { shown: number; active: string | undefined; busy: boolean } = {
  shown: 0,
  active: undefined,
  busy: false,
};

type IntentItem<Intent> = vscode.QuickPickItem & {
  readonly intent?: Intent;
  /** Picking it leaves the quick pick open and tells the core (a folder to drill into). */
  readonly keepsOpen?: boolean;
};

export function showQuickPick<Intent>(model: QuickPickModel<Intent>): Promise<Intent | undefined> {
  return openQuickPick(model, () => undefined).answer;
}

/** A quick pick whose list the core replaces while it is open (ADR 0058). */
export function openQuickPick<Intent>(
  model: QuickPickModel<Intent>,
  onStayOpen: (intent: Intent) => void,
): LivePicker<Intent> {
  const quickPick = vscode.window.createQuickPick<IntentItem<Intent>>();
  quickPick.title = model.title;
  quickPick.matchOnDescription = model.matchOnDescription;
  // A refresh swaps the list under the learner's eyes: what they scrolled to stays put.
  quickPick.keepScrollPosition = true;
  /** What pressing each button asks for: a VS Code button carries no data of ours. */
  const buttonIntents = new Map<vscode.QuickInputButton, Intent>();
  const buttonsOf = (buttons: readonly QuickPickButtonModel<Intent>[]) =>
    buttons.map((button): vscode.QuickInputButton => {
      const drawn = { iconPath: new vscode.ThemeIcon(button.icon), tooltip: button.label };
      buttonIntents.set(drawn, button.intent);
      return drawn;
    });
  /** The title of the list shown: another title is another list (a folder), which starts afresh. */
  let shownTitle: string | undefined;
  const draw = (shown: QuickPickModel<Intent>): void => {
    buttonIntents.clear();
    const anotherList = shownTitle !== undefined && shownTitle !== shown.title;
    shownTitle = shown.title;
    quickPick.title = shown.title;
    if (anotherList) {
      // What was typed filtered the list that is gone, and its scroll position means nothing here.
      quickPick.value = '';
      quickPick.keepScrollPosition = false;
    }
    quickPick.placeholder = shown.placeholder;
    quickPick.busy = shown.busy === true;
    quickPickStats.busy = quickPick.busy;
    quickPick.buttons = buttonsOf(shown.toolbar ?? []);
    const kept = anotherList ? undefined : quickPick.activeItems[0]?.label;
    quickPick.items = shown.entries.map((entry): IntentItem<Intent> =>
      entry.kind === 'separator'
        ? { label: entry.label, kind: vscode.QuickPickItemKind.Separator }
        : {
            label: entry.label,
            ...(entry.description === undefined ? {} : { description: entry.description }),
            ...(entry.detail === undefined ? {} : { detail: entry.detail }),
            ...(entry.buttons === undefined ? {} : { buttons: buttonsOf(entry.buttons) }),
            ...(entry.keepsOpen === true ? { keepsOpen: true } : {}),
            intent: entry.intent,
          },
    );
    quickPick.keepScrollPosition = true;
    // The learner's highlighted item stays highlighted when the list is replaced under it.
    const same = quickPick.items.find((item) => item.label === kept && item.intent !== undefined);
    if (same !== undefined) {
      quickPick.activeItems = [same];
    }
  };
  draw(model);

  let answered = false;
  const answer = new Promise<Intent | undefined>((resolve) => {
    const finish = (intent: Intent | undefined): void => {
      if (!answered) {
        answered = true;
        quickPickStats.busy = false;
        resolve(intent);
        quickPick.dispose();
      }
    };
    quickPick.onDidAccept(() => {
      // Enter with nothing to pick (the typed text matches no item) keeps the quick pick open.
      const picked = quickPick.selectedItems[0];
      if (picked?.intent !== undefined) {
        if (picked.keepsOpen === true) {
          onStayOpen(picked.intent);
        } else {
          finish(picked.intent);
        }
      }
    });
    quickPick.onDidTriggerItemButton(({ button }) => {
      if (buttonIntents.has(button)) {
        finish(buttonIntents.get(button));
      }
    });
    quickPick.onDidTriggerButton((button) => {
      if (!answered && buttonIntents.has(button)) {
        buttonIntents.forEach((intent, drawn) => {
          if (drawn === button) {
            onStayOpen(intent);
          }
        });
      }
    });
    quickPick.onDidHide(() => {
      finish(undefined);
    });
  });
  quickPick.onDidChangeActive((active) => {
    quickPickStats.active = active[0]?.label;
  });
  quickPickStats.shown += 1;
  quickPickStats.active = undefined;
  quickPick.show();
  return {
    answer,
    update(next) {
      if (!answered) {
        draw(next);
      }
    },
  };
}
