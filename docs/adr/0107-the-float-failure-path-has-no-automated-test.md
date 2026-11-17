# The float-failure path in the player panel has no automated test

The #51 gate (comment on PR #114, SOFT 3) found that the adapter half of a floating window that
cannot be made has no test: `cannotFloat` telling the core the player closed, and the `dropped`
guard in the panel's `onDidDispose`. Mutations there survive. The CP3+CP4 review (#12) kept it that
way.

- **No seam reaches it.** Tests live at three seams (CODING_STANDARDS, _Tests_). The core half is at
  Seam 1: a player that closes during a move leaves the Lesson loaded and the next open uses the
  setting (ADR 0102). The adapter half reacts to VS Code: `workbench.action.moveEditorToNewWindow`
  being refused, or the tab not becoming the active editor within 5 s.
- **The smoke test cannot trigger it on cue.** In a real VS Code under `@vscode/test-electron` there
  is no setting or command that makes the move fail, and keeping the tab from becoming active for
  5 s would be a timing test that flakes in CI.
- **A fake `vscode` for the panel** would be a fourth seam, against spec #12's testing decisions,
  for about 20 lines of adapter code.

It is checked by review. Revisit if VS Code adds a way to refuse a move on cue, or if the panel's
placement steps move into the core behind a port.
