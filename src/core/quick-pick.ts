/**
 * The quick pick as a view model, shared by every picker (the Lesson picker, the Course picker).
 * The core builds a model; the UI sink shows it and answers with the intent of the item
 * the learner picked, or `undefined` when the learner closed the quick pick without picking.
 */

/** A button at the end of an item's line: pressing it answers with its own intent. */
export interface QuickPickButtonModel<Intent> {
  /** What the button does, as its tooltip says it. */
  readonly label: string;
  /** The name of a codicon to draw it with, such as `folder-opened`. */
  readonly icon: string;
  /** What pressing the button asks the core to do. */
  readonly intent: Intent;
}

export interface QuickPickItemModel<Intent> {
  readonly kind: 'item';
  readonly label: string;
  /** Shown beside the label, and matched when the learner types if the model says so. */
  readonly description?: string;
  /** What picking this item asks the core to do. */
  readonly intent: Intent;
  /** Buttons beside the item, each with an intent of its own. */
  readonly buttons?: readonly QuickPickButtonModel<Intent>[];
}

/** A heading line that groups the items after it. */
export interface QuickPickSeparatorModel {
  readonly kind: 'separator';
  readonly label: string;
}

/** One line of a quick pick: an item the learner can pick, or a separator above a group. */
export type QuickPickEntry<Intent> = QuickPickItemModel<Intent> | QuickPickSeparatorModel;

export interface QuickPickModel<Intent> {
  readonly title: string;
  readonly placeholder: string;
  /** Whether typing also matches an item's description, not only its label. */
  readonly matchOnDescription: boolean;
  readonly entries: readonly QuickPickEntry<Intent>[];
}
