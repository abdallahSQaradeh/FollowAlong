# Attach from the chord: the core drives the file dialog, the Lesson is fixed at the key press

Spec #12 (story 92) and ticket #57 add `FollowAlong: Attach Resource` and a `Ctrl+'` chord that
attach a Resource to the Loaded Lesson while it plays. ADR 0012 kept the file dialog in the
adapter, so `attachResource(lessonId, path)` stays the tree's "+" route. The chord has no tree
node to name the Lesson, so these are the choices the spec leaves open.

- **The letter is `A`** (`Ctrl+'` `A`, `Cmd+'` `A` on macOS). Taken before: `Space`, `,`, `.`,
  `←`, `→`, `↑`, `↓`, `N`, `P`, `L`. Mark done / not done (#29) takes another letter.
- **A new command, `followalong.attachToLoadedLesson`**, is the Palette's "FollowAlong: Attach
  Resource". The existing `followalong.attachResource` (the tree's "+", run with a node) stays
  hidden from the Palette, as before.
- **The core asks for the file through a new `UiSink.pickFile()`** (it extends the port list of
  ADR 0002 as `ask` and `pick` did). The core, not the extension command, must decide which Lesson
  is meant, and a Seam 1 test can only see that decision if the core runs the whole flow. The
  dialog code itself stays in the adapter; the tree's "+" calls the same helper
  (`pickFileToAttach`). `attachResource` is unchanged. (Revised by ADR 0024: the tree's "+" now
  also lets the core ask, through `attachResource(lessonId)` with no path.)
- **The Lesson is fixed when the key is pressed**, not when the dialog closes: the learner means
  the Lesson they were watching, even if the next one starts while the dialog is open. (Revised by
  ADR 0024: its Course is fixed too, so a Course opened meanwhile never receives the Resource.)
- **The flow never touches the player.** The native dialog does not pause the webview, and the
  core sends no player message. Attaching is not a Focus change: after the dialog closes, whether
  a file was picked, the dialog was closed, or the attach failed, the core calls
  `ui.returnFocus()` (ADR 0009), so the learner is back in the code.
- **With no Lesson loaded** the chord shows "Open a Lesson first, then attach a Resource to it."
  and opens no dialog, so the key is never silent.
- **Loaded, not playing.** The Lesson counts when it is loaded, also while paused: attaching a
  note to a paused Lesson is what the learner means too.
