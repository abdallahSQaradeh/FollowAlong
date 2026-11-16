# Opening a Course in a new window

#40 (spec #12, story 17) adds _Open in new window_ to a Course entry of the Course picker, so the
learner keeps two Courses side by side. These are the choices the spec leaves open; the orchestrator
was told them before the build.

## How the new window learns which Course to open

- **An empty window, plus a note.** The adapter runs `workbench.action.newWindow` (a window with no
  folder), so the Practice area is never changed and the Course folder is not opened as a workspace
  (story 20). The core first leaves a note in the global storage, key `pendingCourse`, as
  `{ folder, at }` (`src/core/pending-course.ts`), `at` from the Clock port.
- **The new window takes the note once.** At activation `restoreCourse` looks at the note only when
  its workspace remembers no Course (story 21: a restored Course is never replaced). The note is
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

- Two windows opened within 30 seconds of the button may race for the note; the first activation
  that remembers no Course takes it.
- The smoke test cannot open a second window reliably; the intent is tested at Seam 1 and the
  window by manual QA.
