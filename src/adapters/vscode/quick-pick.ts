/**
 * The VS Code adapter for the core's quick-pick view models. It knows nothing of any one picker:
 * it draws a {@link QuickPickModel} and answers with the intent of the item the learner picked.
 * The Lesson picker and the Course picker both use it.
 */
import * as vscode from 'vscode';

import type { LivePicker } from '../../core/ports.js';
import type { QuickPickButtonModel, QuickPickModel } from '../../core/quick-pick.js';

/** What answering with an intent does: close the quick pick, or tell the core and stay open. */
interface Answer<Intent> {
  readonly intent: Intent;
  readonly keepsOpen: boolean;
}

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

type IntentItem<Intent> = vscode.QuickPickItem & { readonly answer?: Answer<Intent> };

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
  /** What pressing each button answers: a VS Code button carries no data of ours. */
  const buttonAnswers = new Map<vscode.QuickInputButton, Answer<Intent>>();
  const buttonsOf = (buttons: readonly QuickPickButtonModel<Intent>[]) =>
    buttons.map((button): vscode.QuickInputButton => {
      const drawn = { iconPath: new vscode.ThemeIcon(button.icon), tooltip: button.label };
      buttonAnswers.set(drawn, { intent: button.intent, keepsOpen: button.keepsOpen === true });
      return drawn;
    });
  /** The title of the list shown: another title is another list (a folder), which starts afresh. */
  let shownTitle: string | undefined;
  const draw = (shown: QuickPickModel<Intent>): void => {
    buttonAnswers.clear();
    const anotherList = shownTitle !== undefined && shownTitle !== shown.title;
    shownTitle = shown.title;
    quickPick.title = shown.title;
    if (anotherList) {
      // What was typed filtered the list that is gone.
      quickPick.value = '';
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
            answer: { intent: entry.intent, keepsOpen: entry.keepsOpen === true },
          },
    );
    // The learner's highlighted item and scroll position stay when the list is replaced under it;
    // another list starts at its first item. VS Code keeps the highlight by position when it is
    // told to keep the scroll position, so the first item is set, not left to chance.
    quickPick.keepScrollPosition = !anotherList;
    const wanted = anotherList
      ? quickPick.items.find((item) => item.answer !== undefined)
      : quickPick.items.find((item) => item.label === kept && item.answer !== undefined);
    if (wanted !== undefined) {
      quickPick.activeItems = [wanted];
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
    /** An item or an item button answers: the quick pick closes, unless it keeps open. */
    const answerWith = (answer: Answer<Intent> | undefined): void => {
      if (answer === undefined || answered) {
        return;
      }
      if (answer.keepsOpen) {
        onStayOpen(answer.intent);
      } else {
        finish(answer.intent);
      }
    };
    quickPick.onDidAccept(() => {
      // Enter with nothing to pick (the typed text matches no item) keeps the quick pick open.
      answerWith(quickPick.selectedItems[0]?.answer);
    });
    quickPick.onDidTriggerItemButton(({ button }) => {
      answerWith(buttonAnswers.get(button));
    });
    quickPick.onDidTriggerButton((button) => {
      // A title bar button never closes the quick pick.
      const answer = buttonAnswers.get(button);
      if (answer !== undefined && !answered) {
        onStayOpen(answer.intent);
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
