# Next and previous Lesson: Course order, quiet ends, and the tree follows the loaded Lesson

Spec #12 (story 42) gives `Ctrl+'` `N` / `P` for the next and previous Lesson in Course order, and
leaves the details open. These are the choices, following the pattern of ADR 0013 and 0015 (a
command in, player messages out, nothing read until the key is pressed).

- **Course order is the play order of ADR 0007**: a folder's own Lessons, then its Sections, each
  in natural order, so a press at the end of a Section goes on into the next Section. The core
  finds the open Lesson in `lessonsInOrder(course)` and takes the one beside it. It uses the
  Lesson's id, so a Title list or a renamed title never changes the order.
- **It is the same path as picking a Lesson.** `nextLesson()` and `previousLesson()` call the
  `play` step `playLesson` uses, so the Lesson loads exactly as one picked in the Lesson picker or
  clicked in the tree, and #21's "Next" overlay can call the same path.
- **The ends are quiet.** At the last Lesson `Next` and at the first Lesson `Previous` do nothing:
  no `load`, no message, the same Lesson stays. A key in the Follow-along loop is pressed often and
  without looking; a message at every press at the end would only be noise, and the learner sees
  which Lesson is playing in the tab title and the tree. (Story 50 gives the end of a Lesson its
  own "Next: <title>" overlay, which is #21's.)
- **Before a Lesson is open** the commands say "no Lesson is open" as the playback commands do.
  That includes a Course with no Lessons opened after another Course: the old player still shows
  the old Lesson, but the open Course has no Lesson to move from, so the commands say the same
  and send nothing. (The play/pause, step and speed commands still act on the old Lesson there;
  that is not this ticket's to change, and it is noted for the orchestrator.)
- **While the player page is still starting** the commands still move on, unlike a step or a speed
  press. A step needs a player to act on; a move only changes which Lesson is current, and the
  `load` goes out when the page reports `ready`. Dropping the press would lose a navigation the
  learner can see no reason for.
- **The tree selection follows the loaded Lesson.** `UiSink.selectLesson(lessonId)` is a new port
  method; the core calls it whenever a Lesson is shown (`play`), so it follows Next, Previous, the
  picker, a click and opening a Course alike. The adapter selects and reveals the node, expanding
  its Section, without taking focus (`TreeView.reveal` with `focus: false`), so the learner's
  caret stays in the code. VS Code selects nothing in a view that is not on screen, so the adapter
  keeps the Lesson it was last told to select and selects it when the view becomes visible. A
  `reveal` that fails is logged, not lost. Story 87's highlight of the last Lesson on reopening a Course is
  Progress's (#25 and later); this ticket only keeps the tree in step with what loads.
- **Keys and Palette.** `Ctrl+'` `N` / `P` (`Cmd+'` on macOS, best-effort) when `editorTextFocus ||
terminalFocus`, as the other chords. The commands are `FollowAlong: Next Lesson` and `Previous
Lesson`.
- **Where the Lesson starts** is whatever `load` does today (0:00, autoplay). #25 changes it to the
  Lesson's saved position, for every way of switching Lesson.

## Considered options

- **Wrap around at the ends.** Rejected: the last Lesson of a Course is a place the learner stops;
  jumping back to Lesson 1 would be a surprise (and the opposite of "does nothing harmful").
- **A message at the ends ("This is the last Lesson").** Rejected: see above; it can be added in
  one line if real use shows the silence confuses.
- **Selecting the tree node in the adapter, from the `load` it sees.** Rejected: the adapter would
  have to know which Lesson a `load` means; the core knows, so it tells the UI sink.

## Consequences

- `UiSink` has a new method, `selectLesson`; every UI sink (the VS Code one, the recording fake)
  implements it.
- `LessonTreeView` implements `getParent`, which `TreeView.reveal` needs.
