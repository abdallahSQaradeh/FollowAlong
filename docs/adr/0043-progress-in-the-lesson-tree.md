# Progress in the Lesson tree: one pure view model, glyph in the label, totals rounded down

The Lesson tree shows Progress at a glance (spec #12, stories 86 and 87): a mark per Lesson, the
position of a Lesson in progress, done/total per Section, and done/total with a percent for the
Course. The current Lesson is highlighted and revealed. #29 (mark done by hand) and #30 (mark all
done, resets) build on the same model.

## The view model

`buildLessonTree(course, resources, progress)` (`src/core/lesson-tree.ts`) is a pure function of the
Course, its Resources and its Progress. It reads each Lesson's state with `lessonStatus` (ADR 0030)
and never decides what done or in progress means.

- **Lesson node:** `status` (`notStarted` | `inProgress` | `done`), `glyph` (`○` / `◐` / `✓`) and
  `description`: `12:30 / 40:05` for a Lesson in progress (its saved position and length, in the
  status bar's `mm:ss`), empty for the others. A Lesson whose length was never known shows the
  position alone (`12:30`).
- **Section node:** `done`, `total` and `description` (`3/12`). The counts cover every Lesson under
  the Section, nested Sections included, so a Section's number is what the learner would count by
  opening it all.
- **`summary` on the model:** `{ done, total, percent, description }`, `description` being
  `27/140 · 19%`. The percent is rounded **down**, so `100%` only ever means every Lesson is done
  (99.6 % would otherwise read as finished). The model has no `summary` when it shows a message
  instead of a tree.
- **No "current" flag.** The highlight is `UiSink.selectLesson`, which the core already calls when
  it plays a Lesson (opening a Course selects the last Lesson played, or the first). Keeping the
  current Lesson out of the model keeps it a pure function of Course, Progress and Resources.

## What the adapter draws

- The **glyph leads the Lesson's label** (`✓ Intro`). It replaces the `play-circle` icon, which said
  nothing about Progress; a click on the Lesson still plays it. A glyph in the text is the spec's
  own wording (`✓ / ◐ / ○`), does not depend on which codicons or theme the learner has, and needs
  no icon files.
- `description` is the tree item's description (grey text after the label), for Lessons and
  Sections.
- The Course `summary` is the tree **view's** description, beside the title "Lessons". It is not
  part of the Course node (#56, ADR 0045), which carries the Course Resources and their "+": the
  Progress decoration and the Resource rows stay separate parts of the model, so neither ticket
  has to move around the other.

## Considered options

- **ThemeIcons per state** (codicons for done, in progress and not started). Rejected: they depend
  on the codicon set and the theme, and the stories name the glyphs.
- **The Course summary as a tree node of its own.** Rejected: it would be selectable and
  highlightable like a Lesson, and it is one line of text, which the view's description shows.
- **Percent rounded to the nearest.** Rejected: see above, a Course at 99.6 % would show `100%`.
- **A `current` flag in the model.** Rejected: see above; `selectLesson` already does it.

## Consequences

- #29/#30 add a context menu to Lesson and Section nodes by `contextValue`; the model already
  carries `status` and the Section counts they need.
- A Course that is not a tree (no Lessons) has a message and no summary; `buildLessonTree` is only
  called for a Course with at least one Lesson, so `total` is never 0 there.
