# A headless core behind ports, with a ready handshake for the player

The FollowAlong core (`src/core/`) never imports `vscode`. It is built from one `Ports` record
(`src/core/ports.ts`): Player, File system, Storage, Clock, Converter, Config and UI sink (the list
in spec #12), plus the Logger port that CODING_STANDARDS.md added (`src/core/logger.ts`). Thin
adapters implement them: `src/adapters/node/` for what is plain Node
(file system, clock, converter) and `src/adapters/vscode/` for what needs the VS Code API (webview
panel, mementos, settings, messages, output channel). Seam 1 tests build the same core from fakes
plus the real Node file system adapter, so every decision is tested without VS Code.

The Player port is `show`, `resourceUri`, `send`, `onEvent` and `onDidClose` (ADR 0018). The core
cannot create a webview or call `asWebviewUri`, so `show({title, resourceRoots})` asks the adapter for a player and answers
`created` (a new page is starting; it will post `ready`) or `revealed` (the open player, same
roots, brought to the front; it posts nothing). The core sends `load` only to a player that has
posted `ready`, and sends it again on every `ready`, so a reloaded or reopened page always gets the
current Lesson. `resourceUri` lets the core put the exact URI into the protocol message, so Seam 1
asserts on the messages the player really receives.

## Considered options

- **The adapter waits for `ready` and `show` returns a promise.** Rejected: the page posts `ready`
  again after a reload, so the core needs the event anyway, and two paths would race.
- **The core sends file paths and the adapter rewrites them to webview URIs.** Rejected: two
  message types for one protocol, and Seam 1 would assert on messages the player never sees.

## Consequences

- A new Course needs other `localResourceRoots`. Revised by ADR 0022: the panel adapter keeps the
  open panel and gives it the new roots, and VS Code reloads its page (so `show` answers `created`
  and the page posts `ready`). It no longer disposes the panel. The reload loses the learner's click
  (#12 D3), so the core gives the player the Courses roots as its folders, and Courses under them
  share one page.
- The Converter port is defined now but nothing calls it; until the sound tickets bundle ffmpeg,
  the extension passes a converter that rejects every request.
- When VS Code runs the extension's tests (`ExtensionMode.Test`), `activate` returns the player
  events it received (`TestHooks`), so the smoke test can see the real page play a Lesson. In
  normal use it returns nothing; the hook adds no behaviour.
