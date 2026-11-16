# Focus return: the player reports when an interaction ends, the adapter knows what the learner used last

Any click in the player would leave keyboard focus in the webview, which is a Focus change. Spec
#12 says the extension then refocuses "the editor or terminal that was active before", except
while the seek bar is being dragged. This ADR records how that works. Later work builds on it:
zoom gestures (#46) and the other video spots (#49–#52).

**The player decides when.** It posts `userInteracted {}` (no `lessonId`: it is about the page,
not a Lesson) at the end of each learner interaction. A Seam 2 probe of Chromium's native
`<video controls>` found that the control bar keeps its pointer events to itself. A click on its
buttons reaches no page listener, and neither does the `pointerup` that ends a seek-bar drag. So
the end of an interaction is read from what does reach the page:

- `pointerup` anywhere in the page: a click on the picture, which a transparent overlay above the
  control bar catches (and turns into play/pause at once, without the native player's wait for
  a double-click);
- `lostpointercapture` on the video: the learner let go of the seek bar or the volume slider.
  Between `gotpointercapture` and that event nothing is posted, so focus never leaves mid-drag;
- a change made by a control-bar button: a `play` the player did not start itself, a `pause` the
  extension did not ask for (not the Lesson's end), and `volumechange` (the player never changes
  the volume).

The overlay's own play/pause is marked as the player's, so one click posts one `userInteracted`.

**The core decides that focus returns.** On `userInteracted` it calls `UiSink.returnFocus()`.

**The VS Code adapter knows where focus was.** The stable API cannot read which part has focus.
There is no way to read a context key, and `activeTextEditor` stays set while the terminal has
focus. So `FocusReturn` (`src/adapters/vscode/focus-return.ts`) remembers the last target from the
signals the API does give:

- an editor: a file or untitled text editor became active, its selection changed, or the active
  editor's document was edited;
- a terminal: a terminal became active, a shell command started in it, or it got its first input.

On `returnFocus` it shows that terminal with focus. For an editor, it focuses the editor showing
that document, but only while it is visible, so a tab behind the player is never brought in front
of it.

## Considered options

- **Focus the first editor group** (the prototype's approach). Rejected: it ignores the terminal
  and any other layout.
- **Post `userInteracted` on `pointerdown`, or on the webview's `focus`.** Rejected: this fires at
  the start of a seek-bar drag and would end the drag.
- **Keep the last focus target in the core**, fed by adapter events through a new port. Rejected
  for now: where focus is is a fact about the workbench that only the adapter can observe, as
  `asWebviewUri` is. The core would only store one value the adapter hands it. Seam 1 checks the
  decision (an interaction returns focus). The smoke test checks in real VS Code that focus comes back.
- **Replace the native controls with our own.** Then every pointer event would be ours. Rejected
  for this ticket: it is far larger, and spec #12 keeps the native control bar.

## Consequences

- Known gap: if the learner clicks into a terminal that is already active and types without
  running a command (or the shell has no shell integration), the API reports nothing. A click in
  the player then returns focus to the editor. This is on the Manual QA list.
- The native overflow menu (playback speed, picture-in-picture) and the fullscreen button are not
  reported as interactions. Opening the menu must not close it by moving focus away. Speed has
  FollowAlong's own controls.
- When a later ticket makes the player change the volume itself, it must mark that change as the
  player's, just as `play()` does, or `volumechange` will report it as the learner's.
- Seam 2's default harness posts with Playwright's `page.evaluate`, which counts as a user
  gesture, so there autoplay always works. `openPlayer(page, { userGestures: false })` posts as
  VS Code does, and Chromium then refuses autoplay as VS Code does (#12 D3).
