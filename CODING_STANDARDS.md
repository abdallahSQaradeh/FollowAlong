# Coding standards

The rules every change to FollowAlong follows. The `code-review` skill checks the diff against this
file. Most rules are also enforced by tooling (column **Enforced by**); the rest are for review.

## Architecture

| Rule                                                                                                                                                                                                                             | Enforced by                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/core/**` never imports `vscode`, and never imports an adapter.                                                                                                                                                              | ESLint `no-restricted-imports` (bans `vscode`, `**/adapters/**`, `**/vscode/**`) |
| The core is reached only through the ports in spec #12 (_Implementation Decisions → Architecture_): Player port, File system, Storage, Clock/scheduler, Converter, Config, UI sink, plus the Logger port (`src/core/logger.ts`). | Review                                                                           |
| Adapters stay thin: they translate between VS Code (or Node, or the webview) and a port, and forward to the core. Decisions, rules and state live in the core, where Seam 1 tests reach them.                                    | Review                                                                           |
| The extension and the player talk only through the typed message protocol.                                                                                                                                                       | Review                                                                           |

## Tests

Tests live only at the three seams agreed in spec #12 (_Testing Decisions_) and the `tdd` skill:

| Seam                                         | Folder         | Runner                                              | Script                |
| -------------------------------------------- | -------------- | --------------------------------------------------- | --------------------- |
| Seam 1: the core, through its ports          | `test/unit/`   | Vitest                                              | `npm run test`        |
| Seam 2: the player's message protocol        | `test/player/` | Playwright in Chromium                              | `npm run test:player` |
| Thin smoke test: VS Code loads the extension | `test/smoke/`  | `@vscode/test-electron` (under `xvfb-run` on Linux) | `npm run test:smoke`  |

- A test drives FollowAlong only through a seam's public interface and checks only what the learner
  could observe: player messages, files on disk, and the tree, status bar and quick-pick view models.
  Never internal state, private functions or call order.
- Seam 1 fakes only what cannot run headless (player, clock, converter, storage, config) and uses a
  real temp-dir file system with fixture Course trees.
- Seam 2 tests import `{ test, expect }` from `test/player/fixtures.ts` (ESLint enforces it). The
  fixture echoes browser console warnings and errors so `check-logs` fails on them.
- The smoke test checks nothing Seam 1 or Seam 2 already covers.
- Never skip, focus or `todo` a test (`.skip`, `.only`, `.todo`, `.fixme`, `xit`, …). The
  PreToolUse hook blocks it; Playwright runs with `forbidOnly`.
- Red before green: a new behaviour's test is seen failing before the code makes it pass.

## Vocabulary

Names in code, tests, commits and PRs use the terms in `GLOSSARY.md`: Course, Courses root, Lesson,
Section, Progress, Resource, Practice area, Follow-along loop, Focus change. Never the synonyms it
lists under _Avoid_ (no `episode`, `module`, `workspace` for the Practice area, …). A concept with no
term yet goes to `GLOSSARY.md` in the same PR (`domain-modeling` skill).

## Zero warnings

- `npm run lint` runs ESLint with `--max-warnings 0`: a warning fails like an error.
- TypeScript is `strict` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnused*`.
- Test runs must be silent about problems. `scripts/check-logs.mjs` scans the newest log of each
  test script in `.logs/` and fails on warnings, deprecations, unhandled rejections or errors,
  `console.warn`/`console.error` output from tests, browser console warnings and errors, and
  `Experimental` / `(node:` notices.
- Noise that cannot be fixed (for example a message VS Code itself prints) goes in
  `scripts/check-logs.allow.json`, as a narrow regular expression with a written `reason` and, where
  possible, the `logs` it applies to. Fix causes first; the allowlist is reviewed like code.

## No disabled rules without a reason

- `// eslint-disable-next-line <rule> -- <why>`: the reason after `--` is required
  (`eslint-comments/require-description`), blanket disables are banned, and unused disables fail.
- `// @ts-expect-error <why>` needs a reason of 10+ characters; `@ts-ignore` and `@ts-nocheck` are
  banned.
- Never loosen a lint, type, format or log rule, an npm gate script, a git hook or a Claude Code hook.
  The PreToolUse hooks block such edits, and the shell may not write those files at all.

## Logging

- Code in `src/` logs only through the Logger port (`src/core/logger.ts`); the VS Code adapter
  writes it to an output channel. `console.*` in `src/` and `test/` is an ESLint error.
- Node helper scripts (`scripts/`, `.claude/hooks/`) may use `console`: the terminal is their output.

## Formatting and files

- Prettier formats everything (`.prettierrc.json`); EditorConfig matches it.
- Every text file is LF, on Windows too (`.gitattributes`, `.editorconfig`, Prettier `endOfLine`).
- Helper and hook scripts are Node (`.mjs` with `// @ts-check`), never bash: the product targets
  Windows and CI runs on Windows and Linux.

## The gates

| When                                              | What runs                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent edits a file                                | PostToolUse hook: `prettier --write`, `eslint --fix`, then ESLint and a type check for that file                                                          |
| Agent runs a shell command                        | PreToolUse hook: blocks `--no-verify`, `HUSKY=0`, force-pushes or deletes of `main`/`integration/*`, `git reset --hard` there, shell writes to gate files |
| Agent edits a gate file                           | PreToolUse hook: blocks loosened rules and skipped tests                                                                                                  |
| Agent or subagent stops                           | Stop/SubagentStop hook: `npm run verify:fast` and `npm run check-logs`                                                                                    |
| `git commit`                                      | husky pre-commit: lint-staged (Prettier + ESLint on staged files), then `npm run typecheck`                                                               |
| `git push`                                        | husky pre-push: `npm run verify:fast`                                                                                                                     |
| Pull request / push to `main` or `integration/**` | CI: `verify` on Ubuntu (smoke under xvfb); typecheck, unit, smoke and packaging on Windows; `.logs/` uploaded                                             |

`npm run verify:fast` is format check, lint, typecheck and unit tests. `npm run verify` adds the
player and smoke tests and ends with `check-logs`. Hooks record what they ran in
`.claude/logs/hooks.log`; test scripts write full output to `.logs/<script>-<timestamp>.log`. Both
folders are gitignored. The reasons behind these choices are in `docs/adr/0001-quality-gates.md`.
