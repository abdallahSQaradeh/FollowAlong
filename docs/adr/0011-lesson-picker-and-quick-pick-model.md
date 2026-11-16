# The Lesson picker, and one quick-pick model for every picker

“Go to Lesson…” (`Ctrl+'` `L`) is built in the core as a pure view model (`buildLessonPicker`,
`src/core/lesson-picker.ts`) that the UI sink shows. The model type is generic
(`src/core/quick-pick.ts`): a title, a placeholder, whether typing also matches descriptions, and
entries that are separators or items, each item carrying an **intent**. `UiSink.pick(model)`
resolves with the intent of the picked item, or `undefined` when the learner closes the quick pick.
The VS Code adapter (`src/adapters/vscode/quick-pick.ts`) draws any such model with
`createQuickPick`, so the Course picker (#33) reuses it and adds its own intents and buttons.
These are the details the spec leaves open:

- **Grouping.** A Section with Lessons gets a separator, and each of its items shows the Section as
  its description. A nested Section is named by its path, joined with `/` (`Part 1 / Deep`), so
  two Sections with the same name stay apart. A Section that only holds other Sections gets no
  separator. Wrapper folders follow ADR 0007: the outermost name stays.
- **Lessons in the Course folder.** They come first, with no separator and no description,
  because they belong to no Section. The order is the play order of ADR 0007.
- **Filtering by Section.** The model sets `matchOnDescription`, and VS Code's own matcher does the
  filtering. So typing a Section name narrows the list to it, and typing a title still works; a
  Lesson whose title happens to match the typed text also stays. Core code does not filter.
- **Picking.** The intent is `{type: 'playLesson', lessonId}`: the Lesson loads and starts at once,
  from 0:00 until the Progress tickets add saved positions and the _Start from beginning_ button.
  If another Course was opened while the picker was open, the pick is ignored, because a Lesson id
  is only unique inside its Course (CP1 note) and the learner chose from a list that is gone.
- **No Course open.** The key opens the Course picker instead (story 35, #33, ADR 0022). Until
  #33 the core showed a message that said to run _Open Course…_.
- **The chord.** `ctrl+' l` (`cmd+' l` on macOS, best effort) when `editorTextFocus ||
terminalFocus`, as the spec lists, so it also works in the integrated terminal, where
  `terminal.integrated.allowChords` is on by default.

## Considered options

- **`window.showQuickPick` in the adapter.** Rejected: it has no buttons, and the Course picker
  needs _Refresh_, _Open in new window_ and _Locate…_ buttons, and the Lesson picker needs _Start
  from beginning_. `createQuickPick` serves all of them with the same adapter.
- **Let the core filter by Section name.** Rejected: VS Code already filters as the learner types,
  and a second filter would disagree with what it shows.
- **The adapter reads the picked item's id and the core looks it up.** Rejected: an intent in the
  model lets Seam 1 assert on exactly what picking does, with no lookup that could drift.

## Consequences

- `UiSink` has a new method, `pick`; every UI sink (the VS Code one, the recording fake) implements it.
- Other pickers add an intent type and a builder, and no adapter code.
