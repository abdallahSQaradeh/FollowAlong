// @ts-check
/**
 * PreToolUse hook for Bash. Blocks (exit 2) commands that skip git hooks, force-push to or delete
 * main / integration/*, hard-reset those branches, or write quality-gate files from the shell.
 */
import { checkBash } from './guards.mjs';
import { isRecord, logHook, projectDir, readInput, run, stringField } from './lib.mjs';

const input = readInput();
const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
const command = stringField(toolInput, 'command') ?? '';
const cwd = stringField(input, 'cwd') ?? projectDir;

const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 });
const branch = head.status === 0 ? head.output.trim() : undefined;

const reasons = checkBash(command, branch);
const shown = command.length > 160 ? `${command.slice(0, 160)}…` : command;
if (reasons.length === 0) {
  logHook('pre-bash', `allowed: ${JSON.stringify(shown)}`);
  process.exit(0);
}
logHook('pre-bash', `blocked: ${JSON.stringify(shown)} (${reasons.join(' | ')})`);
process.stderr.write(
  `Blocked by .claude/hooks/pre-bash.mjs:\n${reasons.map((reason) => `- ${reason}`).join('\n')}\n`,
);
process.exit(2);
