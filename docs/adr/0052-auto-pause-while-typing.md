# Auto-pause while typing: a pure step function in the core, fed by the Loaded Lesson

Auto-pause (spec #12, stories 98–105; ticket #59) pauses a playing Lesson when the learner edits
the active editor's document. The spec gives the states and rules; these are the choices it leaves
open. #60 (resume after a quiet period, `overridden`) and #61 (the toggle) build on them.

- **A pure step function.** `stepAutoPause(state, input)` in `src/core/auto-pause.ts` returns the
  next state and a list of effects. It holds no timer and sends nothing. The Loaded Lesson keeps the
  state, feeds it the inputs (`modeChanged`, `typed`, `played`, `lessonLeft`) and carries out the
  effects (today only `pause`). #60 adds inputs (the quiet period elapsed, a manual pause or play)
  and effects (schedule or cancel the resume, resume without rewind), with the clock in the Loaded
  Lesson, so Seam 1 drives it with the fake clock. The state carries its mode, so `pauseAndResume`
  can decide what an edit does without reading the setting again.
- **Which edits count is the core's decision.** The adapter forwards every
  `onDidChangeTextDocument` event that changes text, as `{scheme, path?, inActiveEditor}`, and the
  core keeps only `file` or `untitled` documents in the active editor. Output panels, the Source
  Control box and the user settings (`vscode-userdata`) are other schemes. Formatters and undo/redo
  count (#10: they can't be told apart reliably). Cursor moves are another VS Code event, which the
  adapter does not listen to.
- **FollowAlong's own edits are its own files.** FollowAlong never types into an editor. Its writes
  to Course data on disk make VS Code reload a copy the learner has open, which VS Code reports as
  an edit. So an edit to a file under a `.followalong` folder, or under the extension's storage
  folder (the fallback Course data), never counts. Telling these apart by "the document was reloaded
  from disk" would also drop a file another tool rewrites, which the spec doesn't ask for.
- **It acts only on a Lesson the player reports playing**, on a ready page. An edit while paused,
  ended, starting or with nothing loaded does nothing and says nothing. A burst of keystrokes
  before the player reports the pause sends one `pause`: the state is already `autoPaused`.
- **What ends an auto-pause.** The Lesson playing again (whoever started it), the Lesson ending,
  the learner leaving it (another Lesson or Course, a closed player), and the setting turned off.
  Each one returns to `armed` (or `off`).
- **"Paused (typing)" holds as long as the auto-pause does.** The play/pause status bar item reads
  "Paused (typing)" while the state is `autoPaused` and the Lesson is not playing. No extra timer:
  with `pauseAndResume` it is brief by nature, and with `pause` it keeps saying why the video
  stopped until the learner plays it again.
- **The marker is on the play/pause item** (#10's resolution): a `marker: 'autoPause'` drawn as the
  `keyboard` codicon after the play or pause icon, and the tooltip names the mode ("Auto-pause:
  pause", "Auto-pause: pause and resume"). Like every status bar item, it shows only while a Lesson
  is loaded.
- **`pauseAndResume` is in the setting now.** The ticket names all three values. Until #60 lands,
  it pauses like `pause` and does not resume.
- **An unknown setting value is `off`.** A hand-edited typo (`"Pause"`) never pauses anything.

## Consequences

- A refused `play` (#12 D3) is #60's to handle when it auto-resumes. A core-sent `pause` is never
  refused, so #59 has no refusal path.
