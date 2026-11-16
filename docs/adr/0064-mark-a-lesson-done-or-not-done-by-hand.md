# Marking one Lesson done or not done by hand: one toggle on the Loaded Lesson, two items in the tree

Spec #12 (story 78) lets the learner correct one Lesson's state by hand (#29). ADR 0061 built the
marking path (`markLessonsDone`, `resetLessons`, `showAndSave`); this ADR records the choices #29
leaves open and does not build a second path.

## The rules

- **One toggle for the chord and the Command Palette.** `Ctrl+'` `D` (D10 on #12) and
  `FollowAlong: Mark done / not done` run `toggleLessonDone`: a Lesson that is done becomes not
  done, any other Lesson (not started or in progress) becomes done.
- **The toggle acts on the Loaded Lesson**, the one the learner is on, fixed when the key is
  pressed, like the attach chord (ADR 0023). With no Course open or no Lesson loaded it shows
  "Open a Lesson first, then mark it done." and changes nothing.
- **The tree's Lesson menu has two items, not a toggle:** `Mark done` and `Mark not done`, both
  on any Lesson of the open Course, whatever its state. They are hidden from the Command Palette
  (they need the Lesson they were run on). A Lesson the open Course does not have is logged and
  changes nothing, like an unknown Section (ADR 0061).
- **"Not done" is a reset** (ADR 0061, GLOSSARY _Reset_): the done mark and the saved position go,
  so the sticky done state is cleared and the Lesson reads as never played. A Lesson the learner
  had half-watched and then marked done and not done starts again at 0:00. "Done" keeps the
  position, as _Mark all done_ does.
- **Every change goes through `markLessonsDone` / `resetLessons` with one id**, so the tree is
  refreshed and the change saved by `showAndSave`; the command resolves once it is saved.
  `resetLessons` also restarts the 10 s of play of the Loaded Lesson when it is the one reset.

## Considered options

- **"Mark not done" keeps the position.** Rejected: ADR 0061 says "not done" is a reset unless the
  ticket decides otherwise, and #29 does not. A done mark with no position is simply a Lesson
  that was never played.
- **One toggle item in the tree menu.** Rejected: the tree has no per-item state in its context
  value, and two explicit items say what they do without the learner reading the glyph first.
- **The toggle acts on the Lesson selected in the tree.** Rejected: the tree selection follows the
  Loaded Lesson (`selectedLesson`), and the chord is a playback-time key.
