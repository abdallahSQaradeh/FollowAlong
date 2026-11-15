// @ts-check
/**
 * PreToolUse hook for Edit, Write and MultiEdit. Blocks (exit 2) edits that loosen the quality
 * gates (lint, tsconfig, npm scripts, git hooks, Claude Code hooks, check-logs) or skip a test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { checkEdit } from './guards.mjs';
import { isRecord, logHook, projectDir, readInput, stringField } from './lib.mjs';

const input = readInput();
const tool = stringField(input, 'tool_name') ?? '';
const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
const filePath = stringField(toolInput, 'file_path');
if (filePath === undefined) {
  process.exit(0);
}
const absolute = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
const relativePath = relative(projectDir, absolute).replace(/\\/g, '/');
if (relativePath.startsWith('..')) {
  process.exit(0);
}

const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
const after = afterEdit(tool, toolInput, before ?? '');
if (after === undefined) {
  process.exit(0);
}

const reasons = checkEdit(relativePath, before, after);
if (reasons.length === 0) {
  logHook('pre-edit', `${tool} ${relativePath}: allowed`);
  process.exit(0);
}
logHook('pre-edit', `${tool} ${relativePath}: blocked (${reasons.join(' | ')})`);
process.stderr.write(
  `Blocked by .claude/hooks/pre-edit.mjs. The quality gates may only get stricter:\n${reasons.map((reason) => `- ${reason}`).join('\n')}\n`,
);
process.exit(2);

/**
 * Works out the file's content after the edit.
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string} current
 * @returns {string | undefined}
 */
function afterEdit(toolName, args, current) {
  if (toolName === 'Write') {
    return stringField(args, 'content');
  }
  /** @type {unknown[]} */
  const edits = toolName === 'MultiEdit' && Array.isArray(args.edits) ? args.edits : [args];
  let text = current;
  for (const edit of edits) {
    if (!isRecord(edit)) {
      continue;
    }
    const oldString = stringField(edit, 'old_string') ?? '';
    const newString = stringField(edit, 'new_string') ?? '';
    text =
      edit.replace_all === true
        ? text.split(oldString).join(newString)
        : text.replace(oldString, () => newString);
  }
  return text;
}
