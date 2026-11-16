# The core is two modules: the Course side and the Loaded Lesson, behind one FollowAlong interface

By CP1 (the first architecture checkpoint), `src/core/follow-along.ts` had grown to about 1,050
lines with two jobs woven together:

- **The Course side:** opening Courses one at a time, the `switching` guard, Course data and
  Resources, the pickers, and moving between Lessons.
- **The player side:** which `load` is current (`loadId`, ADR 0022), whether the page takes
  commands, the autoplay-refusal record, the rate and the speed ladder, the Rewind the page holds,
  the status bar model, and saving Progress while a Lesson plays.

Every playback ticket (#26–#30, #41–#52) adds to the player side. We split it out into
`src/core/loaded-lesson.ts`, named after the glossary's **Loaded Lesson**.

- **The interface is small.** `lesson()`, `load(lesson, {startAt, autoplay, resourceRoots})`,
  `leave()`, `unload(pause)`, the playback commands and `dispose()`. Behind it sit the player event
  dispatch, `loadId` gating, rate reconciliation, autoplay refusal, the save timer and the status
  bar. It needs three things from the Course side, passed in as a `LessonCourse`: the open Course's
  Progress, the Lesson after a given Lesson in Course order, and what to do when the Next overlay is
  clicked.
- **The seam is internal.** `createFollowAlong(ports)` and its `FollowAlong` interface do not
  change. Seam 1 tests still reach both modules only through it, and no test imports
  `loaded-lesson.ts` (CODING_STANDARDS.md, _Tests_). The split moved no test. The 294 Seam 1 tests
  that passed before it pass after it, and their bodies are unchanged.
- **A Lesson is compared by identity, not by its id, inside the open Course.** Another Course can
  hold a Lesson with the same id (`01.mp4`).
  - Player events already carry the `loadId` (ADR 0022).
  - Finding the Lesson beside the Loaded Lesson compares the `Lesson` objects of the open
    Course, so a Lesson from another Course is not found there.
  - Anything that crosses an `await` keeps the Course with the Lesson it names. The attach from
    the chord fixes both the Lesson and its Course at the key press (ADR 0023), so a Course opened
    while the file dialog is up never receives the Resource. That fix is the one behaviour change
    of CP1, with a red-then-green Seam 1 test.

## Considered options

- **A page-lifecycle module only** (`ready`/`closed`, rate, Rewind). Rejected: it would remove the
  scattered resets, but leave the event dispatch, Progress wiring and commands in
  `follow-along.ts`, so the hot spot stays.
- **Progress stays on the Course side, wired in with callbacks per event.** Rejected: the
  `engaged` and start-seek rules and the save timer belong to the Loaded Lesson's events. Four or
  five callbacks would make the new module a pass-through. It reads the open Course's
  `ProgressRecorder` through one getter instead.
- **A Seam 1 test surface for the Loaded Lesson on its own.** Rejected: it would be a second test
  seam over code the `FollowAlong` interface already reaches, and those tests would break on
  every internal refactor.
- **Splitting the Course side further** (a Course-session module for the open queue, Resources
  and navigation). Deferred, not rejected: #58 reshapes the Resources part (D5 amended, two
  locations merged), and a Resources module like Progress's `openProgress` belongs there.
