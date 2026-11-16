/**
 * The one-time terminal prompt (spec #12, story 45). Keys with a chord work in VS Code's terminal
 * as they are, but the three one-press keys go to the shell unless their commands are in the
 * learner's `terminal.integrated.commandsToSkipShell`. The core asks once whether to add them.
 */
import type { Ports, Question } from './ports.js';

/** The commands of the one-press keys: Ctrl+Alt+Space, and Ctrl+Alt+← / →. */
export const onePressCommands: readonly string[] = [
  'followalong.playPause',
  'followalong.seekBackShort',
  'followalong.seekForwardShort',
];

/** The key of the learner's answer in global state. */
export const terminalAnswerKey = 'followalong.terminalSkipShellAnswer';

export const terminalQuestion: Question = {
  text: 'FollowAlong can add its one-press keys (Ctrl+Alt+Space, Ctrl+Alt+←, Ctrl+Alt+→) to terminal.integrated.commandsToSkipShell, so they also work while the terminal has focus. Your existing entries stay.',
  accept: 'Add them',
  decline: 'No thanks',
};

/** What agreeing does to the learner's setting. */
export type SkipShellChange =
  | { readonly kind: 'write'; readonly commands: readonly string[] }
  /** The learner has all three commands already. */
  | { readonly kind: 'unchanged' }
  /** The value is not a list of commands: writing would replace something unknown. */
  | { readonly kind: 'unreadable' };

/**
 * The learner's entries (`stored`, as VS Code holds them: unset, or a list of commands) with the
 * one-press commands they lack added after them. Nothing the learner has is removed or moved,
 * including the `-command` entries that take a command out of VS Code's defaults.
 */
export function addOnePressCommands(stored: unknown): SkipShellChange {
  if (stored !== undefined && !(Array.isArray(stored) && stored.every(isString))) {
    return { kind: 'unreadable' };
  }
  const existing: readonly string[] = stored ?? [];
  const missing = onePressCommands.filter((command) => !existing.includes(command));
  return missing.length === 0
    ? { kind: 'unchanged' }
    : { kind: 'write', commands: [...existing, ...missing] };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * The offer: `offer()` asks the learner once, whenever a Lesson opens, and does what they answered.
 * It never blocks the caller, and it never throws.
 */
export function createTerminalKeysOffer(
  ports: Pick<Ports, 'ui' | 'storage' | 'logger' | 'terminalSettings'>,
): () => void {
  const { ui, storage, logger, terminalSettings } = ports;
  /** Whether the learner was asked in this window: a question closed unanswered is not asked again. */
  let asked = false;

  async function run(): Promise<void> {
    const answer = await ui.ask(terminalQuestion);
    if (answer === undefined) {
      return;
    }
    // Remembered before the setting is written: a failed write is told once, not at every Lesson.
    await storage.global.set(terminalAnswerKey, answer);
    if (answer === 'decline') {
      return;
    }
    const change = addOnePressCommands(terminalSettings.skipShellCommands());
    if (change.kind === 'write') {
      await terminalSettings.setSkipShellCommands(change.commands);
      logger.log({ level: 'info', message: 'Added the one-press commands to the terminal keys.' });
    } else if (change.kind === 'unreadable') {
      const text =
        "FollowAlong can't read your terminal.integrated.commandsToSkipShell setting (it is not a list of commands), so it left it as it is.";
      logger.log({ level: 'warn', message: text });
      ui.showMessage({ severity: 'warning', text });
    }
  }

  return () => {
    if (asked || storage.global.get(terminalAnswerKey) !== undefined) {
      return;
    }
    asked = true;
    run().catch((error: unknown) => {
      logger.log({
        level: 'warn',
        message: `Could not add the terminal keys: ${error instanceof Error ? error.message : String(error)}`,
      });
      ui.showMessage({
        severity: 'error',
        text: 'FollowAlong could not add its keys to your terminal settings. Nothing was changed.',
      });
    });
  };
}
