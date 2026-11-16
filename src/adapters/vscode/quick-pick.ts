/**
 * The VS Code adapter for the core's quick-pick view models. It knows nothing of any one picker:
 * it draws a {@link QuickPickModel} and answers with the intent of the item the learner picked.
 * The Lesson picker and the Course picker both use it.
 */
import * as vscode from 'vscode';

import type { QuickPickButtonModel, QuickPickModel } from '../../core/quick-pick.js';

/** How many quick picks were shown: the smoke test waits on it instead of racing the scan. */
export const quickPicksShown = { count: 0 };

type IntentItem<Intent> = vscode.QuickPickItem & { readonly intent?: Intent };

export function showQuickPick<Intent>(model: QuickPickModel<Intent>): Promise<Intent | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<IntentItem<Intent>>();
    quickPick.title = model.title;
    quickPick.placeholder = model.placeholder;
    quickPick.matchOnDescription = model.matchOnDescription;
    /** What pressing each button asks for: a VS Code button carries no data of ours. */
    const buttonIntents = new Map<vscode.QuickInputButton, Intent>();
    const buttonsOf = (buttons: readonly QuickPickButtonModel<Intent>[]) =>
      buttons.map((button): vscode.QuickInputButton => {
        const drawn = { iconPath: new vscode.ThemeIcon(button.icon), tooltip: button.label };
        buttonIntents.set(drawn, button.intent);
        return drawn;
      });
    quickPick.items = model.entries.map((entry): IntentItem<Intent> =>
      entry.kind === 'separator'
        ? { label: entry.label, kind: vscode.QuickPickItemKind.Separator }
        : {
            label: entry.label,
            ...(entry.description === undefined ? {} : { description: entry.description }),
            ...(entry.buttons === undefined ? {} : { buttons: buttonsOf(entry.buttons) }),
            intent: entry.intent,
          },
    );

    let answered = false;
    const answer = (intent: Intent | undefined): void => {
      if (!answered) {
        answered = true;
        resolve(intent);
        quickPick.dispose();
      }
    };
    quickPick.onDidAccept(() => {
      // Enter with nothing to pick (the typed text matches no item) keeps the quick pick open.
      const picked = quickPick.selectedItems[0];
      if (picked?.intent !== undefined) {
        answer(picked.intent);
      }
    });
    quickPick.onDidTriggerItemButton(({ button }) => {
      if (buttonIntents.has(button)) {
        answer(buttonIntents.get(button));
      }
    });
    quickPick.onDidHide(() => {
      answer(undefined);
    });
    quickPicksShown.count += 1;
    quickPick.show();
  });
}
