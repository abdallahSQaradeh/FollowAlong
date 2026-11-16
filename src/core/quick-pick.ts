/**
 * The quick pick as a view model, shared by every picker (the Lesson picker, the Course picker).
 * The core builds a model; the UI sink shows it and answers with the intent of the item
 * the learner picked, or `undefined` when the learner closed the quick pick without picking.
 */

export interface QuickPickItemModel<Intent> {
  readonly kind: 'item';
  readonly label: string;
  /** Shown beside the label, and matched when the learner types if the model says so. */
  readonly description?: string;
  /** What picking this item asks the core to do. */
  readonly intent: Intent;
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
