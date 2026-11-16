# URL Resources open in Simple Browser, in the Resources' group beside the code

Spec #12 (story 94) opens URLs in Simple Browser, and D4 says a Resource never opens in the player's
editor group (ADR 0012, #53, #54). Simple Browser can be aimed at a group, so this needs no workaround.

- **Choice of opener is the core's.** `openResource` on a URL Resource sends
  `UiSink.openResource({ kind: 'url', url })`; `ResourceTarget` is now a union, and the other kinds
  keep `{ kind, path }`. The core decides that a URL goes to Simple Browser (Seam 1 sees the target
  the UI sink receives); the adapter only carries it out.
- **How it is aimed.** The adapter runs the command that VS Code's built-in Simple Browser extension
  offers for other extensions, `simpleBrowser.api.open`, with the address as a `Uri` and
  `{ viewColumn, preserveFocus: true }`. `viewColumn` is the same column `ResourcePlacement.column()`
  gives a file Resource, so a web page opens in the group that already holds Resources, else a group
  that is not the player's, else a new group to the right of the player; focus stays in the code.
  The Simple Browser tab counts as a Resource tab (`isResourceViewType`), so the next Resource goes
  to its group. It is not added to `opened` paths, which are file paths.
- **Not a shell, not a URL scheme handler.** Nothing is passed to a shell, to `vscode.env.openExternal`
  or to `vscode.open`: those would also run `command:` and `vscode:` links. The scheme is checked
  first (ADR 0047).
- **If Simple Browser is not there.** The built-in extension can be disabled; the command then
  fails, and the learner is told FollowAlong could not open the page in Simple Browser.

## Consequences

- Whether `preserveFocus` and `viewColumn` are honoured by the VS Code version in use is not
  reachable from Seam 1 or from a headless smoke test: the PR for #55 lists a Windows manual QA item for it.
