# Quality gates that agents cannot skip

FollowAlong is built by unattended agent sessions, so feedback on format, lint, types, tests and
log noise has to be automatic and unskippable rather than a convention: Claude Code hooks check
every edit and every stop, git hooks check every commit and push, and CI checks every pull request
on Ubuntu and Windows. The gates themselves are protected: a hook blocks shell writes to gate files
and edits that loosen them, so the only way through a red gate is to fix the cause.

## Considered options

- **Strictness.** TypeScript `strict` plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`;
  `--max-warnings 0`. Starting strict is cheap with no code yet; tightening later means touching
  every file. Rejected: `recommended` configs with warnings, because agents ignore warnings.
- **Log checks (`scripts/check-logs.mjs`) instead of trusting exit codes.** Test runners exit 0 on
  `console.warn`, deprecations and many unhandled rejections. Every test script tees its full
  output to `.logs/`, and a scanner fails on those patterns, with an allowlist whose entries need a
  written reason. Rejected: failing tests from inside each runner (a console spy per runner),
  because it misses output from Node itself and from VS Code in the smoke test.
- **Node scripts, not bash.** The product targets Windows and CI runs on Windows, so every hook and
  helper is a `.mjs` file type-checked with `// @ts-check`, and package binaries run through Node
  rather than `.cmd` shims or a shell.
- **Exact dependency versions.** Pinned so a gate never changes under a session. `@playwright/test`
  is pinned to the version whose Chromium is preinstalled in cloud sessions; CI installs the same
  build. TypeScript stays on 6.0 because typescript-eslint does not yet support 7.
- **CommonJS package.** `package.json` has no `"type": "module"`, so the smoke suite compiles to
  CommonJS that VS Code's extension host loads; tooling configs that need ESM use `.mjs`/`.mts`.
  Ticket #13 may revisit this when it picks the extension's bundling.
- **The smoke test runs VS Code 1.146.0**, the `engines.vscode` floor the spec targets, so CI fails
  if the extension relies on anything newer.

## Consequences

- A Stop hook runs `verify:fast` (seconds today) whenever the working tree changed since the last
  green run. If the suite grows slow, move work out of `verify:fast`, never out of CI.
- Changing a gate deliberately (stricter is always allowed) goes through the Edit tool; loosening one
  needs a human outside the agent hooks and a new ADR.
