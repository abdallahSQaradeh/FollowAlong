# The floating window: a player tab moved into a compact, always-on-top window

#51 adds the fifth Video spot of spec #12 (stories 53, 56, 58): `floatingWindow`, the player in a
VS Code window of its own, compact and always on top, resized with the OS window edges. The spec
gives the recipe (from the prototype): open the webview editor, wait until it is active, then run
`workbench.action.moveEditorToNewWindow`, `enableCompactAuxiliaryWindow` and
`toggleWindowAlwaysOnTop`. These are the choices it left open. Source: #51, spec #12, ADR 0049,
ADR 0092, the orchestrator's binding notes on #51, and the VS Code 1.146.0 source
(`auxiliaryEditorPart.ts`, `electron-browser/actions/windowActions.ts`, `editorActions.ts`).

## In the core

- **`floatingWindow` is a spot like the others** (ADR 0049). It is a value of
  `followalong.videoLocation` and a target of _Move video to…_, never the default: the setting
  still defaults to `editorSplit`, and an unknown value still means `editorSplit`. Moving in and
  out, collapsing and restoring (ADR 0092) run the move of ADR 0049 unchanged: a snapshot with a
  1 s wait, a new page that takes over time, speed, play or pause and zoom (with its pan, #47),
  and the D3 message when VS Code refuses to start a Lesson that played. A move never writes the
  setting. Seam 1 covers it.
- **The picker says what the spot costs** (story 58): the _Floating window_ entry of
  _Move video to…_ carries the detail "Always on top. A click in it moves the focus out of this
  window." The description stays free for "where it is now".
- **The learner closing the floating window closes the player.** No new port event: see below.

## In VS Code

- **The tab opens as the active editor, without its page.** `moveEditorToNewWindow` takes no editor
  an extension can name, so it moves the active editor: the player's panel opens in the active
  group with `preserveFocus: false`. Its page starts only once the tab is in the new window, so the
  learner never gets a page that is dropped a moment later, and the new page posts the one `ready`
  the core waits for.
- **The steps, in order, as one step of the spot-change queue** (ADR 0092, item 2): wait until the
  tab is the active editor (5 s safety wait, as for a view) → `workbench.action.moveEditorToNewWindow`
  → 600 ms for the new window to take the OS focus (the prototype's measured wait; the next two
  commands act on the window that has it) → `workbench.action.enableCompactAuxiliaryWindow` →
  `workbench.action.enableWindowAlwaysOnTop` → start the page → hand focus back to the code
  (ADR 0009). Each step first checks the player has not moved on, so the spot asked for last wins.
- **`enableWindowAlwaysOnTop`, not `toggleWindowAlwaysOnTop`.** Both exist in 1.146 and both act
  only when the window with the focus is an auxiliary window (`isAuxiliaryWindow`), so neither can
  pin the main window. The enable command cannot turn the pin off if a window was already on top;
  the toggle could (orchestrator, note 1 on #51). Likewise `enableCompactAuxiliaryWindow` only reaches
  an auxiliary window. A VS Code without either command, or one that refuses it, is logged and the
  float goes on: a floating window that is not on top, or not compact, is still the feature.
- **Focus goes back to the code** after the window is made. The window stays visible because it is
  on top; the prototype kept the focus in it only because, without the pin, the main window would
  cover it. This follows #12 D12 (focus return wins) and ADR 0009.
- **When it cannot float.** A tab that does not become active within 5 s, or a move VS Code refuses,
  is handled like a view that does not open (ADR 0049): the tab is dropped, the learner is told
  once, and the core is told the player closed, so it never waits for a page: nothing is left
  half-open, and the next Lesson opens at the setting (orchestrator, note 4; Seam 1 covers it with
  the fake player closing before its page starts).
- **Resources stay in the main window** (D4, ADR 0012). The floating player is in no editor group of
  the main window: the adapter reports no column for it, so a Resource opens `ViewColumn.Beside`
  the code, as for a view spot.
- **Leaving and collapsing.** Leaving the floating window, or collapsing the video there, drops the
  player tab. It was the window's only editor, and VS Code 1.146 closes an auxiliary window when its
  last group goes (`removeGroup` → `doRemoveLastGroup`). Restoring makes a new floating window.
- **The learner closes the floating window.** On its close button VS Code 1.146 runs
  `AuxiliaryEditorPart.close()` → `doClose(true)`: it first closes every editor that asks nothing
  before it closes (`closeAllEditors({ excludeConfirming: true, force: true })`), then merges the
  rest into the main window. The player tab asks nothing, so it closes, and the panel's dispose is
  the close the core already handles: Progress is saved, the Lesson unloads, and the next Lesson
  opens at the setting (ADR 0049), as when the learner closes the player tab. The smoke test
  checks it by closing the window's page itself, which runs the same unload. It never writes
  `followalong.videoLocation` (orchestrator, note 2).

## Measured (smoke test, CI)

MEASUREMENTS

## Consequences

- The focus caveat (story 58) is a Windows manual QA item: a click in the floating window gives the
  OS focus to that window, and whether the focus return after the click (ADR 0009) brings the OS
  focus back to the main window cannot be seen from a headless run.
- Whether the OS keeps the window on top is also Windows manual QA: no page can read it.
- A learner who drags the floating tab back into the main window (or into another floating window)
  by hand is not fought (orchestrator, note 3): the page plays on, and the spot is still reported as
  `floatingWindow` until the next move. Picking another spot moves it as usual; picking
  _Floating window_ again moves nothing until then. Not handled: `onDidChangeViewState` and the tab
  API tell an extension nothing about which window a tab is in.
