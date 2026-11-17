/**
 * The quick pick as a view model, shared by every picker (the Lesson picker, the Course picker).
 * The core builds a model; the UI sink shows it and answers with the intent of the item
 * the learner picked, or `undefined` when the learner closed the quick pick without picking.
 */

/**
 * What answering with an intent does to the quick pick. By default picking an item, or pressing
 * the button beside one, closes the quick pick and answers with the intent. With `keepsOpen` it
 * does not: as for a title bar button, the core is told the intent while the quick pick stays
 * open, and may replace the model (a folder to drill into, ADR 0066; a Hide, ADR 0072). The text
 * the learner typed is cleared when the core replaces the list under another title, because it
 * filtered the list that is gone. Items and their buttons share the flag.
 */
interface KeepsOpen {
  readonly keepsOpen?: boolean;
}

/** A button, in the title bar or beside an item: pressing it answers with its own intent. */
export interface QuickPickButtonModel<Intent> {
  /** What the button does, as its tooltip says it. */
  readonly label: string;
  /** The name of a codicon to draw it with, such as `folder-opened`. */
  readonly icon: string;
  /** What pressing the button asks the core to do. */
  readonly intent: Intent;
}

/** A button at the end of an item's line. */
export interface QuickPickItemButtonModel<Intent> extends QuickPickButtonModel<Intent>, KeepsOpen {}

export interface QuickPickItemModel<Intent> extends KeepsOpen {
  readonly kind: 'item';
  readonly label: string;
  /** Shown beside the label, and matched when the learner types if the model says so. */
  readonly description?: string;
  /** A second line under the label (a Course's Progress line); never matched when typing. */
  readonly detail?: string;
  /** What picking this item asks the core to do. */
  readonly intent: Intent;
  /** Buttons beside the item, each with an intent of its own. */
  readonly buttons?: readonly QuickPickItemButtonModel<Intent>[];
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
  /**
   * Whether the core is still reading what the list holds: the quick pick shows its busy indicator
   * and the core will replace the model when it is done. Left out when the list is complete.
   */
  readonly busy?: boolean;
  /**
   * Buttons in the title bar. Pressing one never closes the quick pick: the core is told, and may
   * replace the model (a Refresh).
   */
  readonly toolbar?: readonly QuickPickButtonModel<Intent>[];
}
