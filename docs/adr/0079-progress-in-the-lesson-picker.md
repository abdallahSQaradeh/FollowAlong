# Progress in the Lesson picker

#32 shows where the learner left off in “Go to Lesson…” (spec #12, stories 31, 33, 34). It builds on
the Progress rules (ADR 0010, 0030), the Lesson tree's glyphs and position text (ADR 0043, #28) and the
generic item button of the quick pick model (ADR 0072, #38). These are the choices the spec
leaves open.

- **The glyph is the first character of the label.** `✓ Intro`, `◐ Limits`, `○ Series`. The
  description keeps the Section path, then ` · 12:30 / 40:05` for a Lesson in progress. Typing a
  Section name still narrows the list (story 32): the Section stays in the description, which the
  model asks the quick pick to match, and the glyph does not sit in the way of a title match.
- **No second formatter.** The glyph is `lessonGlyphs`, the status is `lessonStatus`, and the
  position text is the tree's `playheadText` (exported from `lesson-tree.ts`), so the picker and
  the tree can never disagree.
- **The picker passes an intent; the core starts the Lesson.** `playLesson` starts where
  `resumePosition` says (ADR 0010, 0030: 5 s before the saved position, 0:00 for a done Lesson
  saved in its last 5%). `playLessonFromStart` starts at 0:00. Both play right away (story 33);
  a refused autoplay shows “Press play in the player” as for any other Lesson (D3).
- **Start from beginning is an item button on every Lesson**, from #38's generic item-button
  model, without `staysOpen`: it closes the picker and answers with its intent.
- **`UiSink.pick`, not the live picker.** The Lesson's list is complete and instant (it is the
  open Course's outline and Progress), so nothing is updated while it is open; the live picker
  (ADR 0058) exists for lists that fill in the background.
