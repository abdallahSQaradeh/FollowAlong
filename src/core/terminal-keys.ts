/**
 * The one-time terminal prompt (spec #12, story 45). Keys with a chord work in VS Code's terminal
 * as they are, but the three one-press keys go to the shell unless their commands are in the
 * learner's `terminal.integrated.commandsToSkipShell`. The core asks once whether to add them.
 */
import type { Question } from './ports.js';

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

/** The setting's value with the one-press commands added after the entries it has. */
export function withOnePressCommands(existing: readonly string[]): readonly string[] {
  return [...existing, ...onePressCommands];
}
