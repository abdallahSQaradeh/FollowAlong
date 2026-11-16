# Opening a Course in a new window

#40 (spec #12, story 17) adds _Open in new window_ to a Course entry of the Course picker, so the
learner keeps two Courses side by side. These are the choices the spec leaves open; the orchestrator
approved them (conditions: activation, consume once, the Seam 1 cases).

## How the new window learns which Course to open

- **An empty window, plus a note.** The adapter runs `workbench.action.newWindow` (a window with no
  folder), so the Practice area is never changed and the Course folder is not opened as a workspace
  (story 20). The core first leaves a note in the global storage, key `pendingCourse`, as
  `{ folder, at }` (`src/core/pending-course.ts`), `at` from the Clock port.
- **The new window takes the note once.** At activation (`onStartupFinished`, which already runs
  `restoreCourse`; no new activation event) a window whose workspace remembers a Course restores
  it and leaves the note alone (story 21). A window that remembers none takes the note: it is
  cleared before the Course is opened, so it is used at most once. The Course then opens like any
  other, so the new window remembers it per workspace.
- **A note lives 30 seconds.** An older note, or one with a future time or a damaged value, is
  dropped unused, so a stray note never opens a Course in a window opened later.
- **A refused window is undone.** If opening the window fails, the note is taken back, the error is
  logged, and the learner is told in one message.
- **This window is untouched**: no Course, Progress or player change; the picker closes.

## The button

A generic item button (ADR 0072) with the intent `openCourseInNewWindow`, on every Course entry
that is not missing, in Recent and in the A–Z list. It does not stay open: the picker closes as for
any pick. A missing Recent Course keeps _Locate…_ and _Remove_.

## Considered

- **A URI or command argument to the new window.** VS Code's `newWindow` command takes none, and
  `vscode://` URIs open an arbitrary window, not necessarily a new one.
- **Opening the Course folder as the new window's workspace.** Rejected: story 20.

## Consequences

- The first window with no remembered Course to activate within 30 seconds of the button takes the
  note. The global storage can reach another window a little late, so another empty window opened
  in that time might take it instead; that is the price of a hand-off with no window identity, and
  the 30 seconds bound it.
- If VS Code gives all empty windows one workspace state, the new window may find a remembered
  Course and restore that instead of the note. Manual QA checks this on Windows; the answer, if
  it fails, is to let a fresh note win.
- Recorded as the Course hand-off in GLOSSARY.md.
- The smoke test cannot open a second window reliably; the intent is tested at Seam 1 and the
  window by manual QA.
