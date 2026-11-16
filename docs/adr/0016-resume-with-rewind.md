# Resume with rewind: the core steps back before a manual resume, an automatic resume does not

A Rewind (see `GLOSSARY.md`) is the seconds the video jumps back when the learner resumes a paused
Lesson by hand (spec #12, story 51). The spec leaves the mechanics open; these are the choices.

- **The core sends `seekBy` then `play`.** On a manual resume with the `followalong.resumeRewind`
  setting above 0 the core sends `seekBy {-N}` and then `play`. The player already clamps `seekBy`
  at 0 (ADR 0013), so "not below 0" needs no new code, and the player stays the owner of the playhead.
- **A manual resume is the play/pause command** when the Lesson is not playing. The key, the command
  palette and later the status bar all reach it.
- **The setting is read on every press**, like the step sizes (ADR 0013). A value that is not a
  finite number above 0 (`0`, a negative, `"4"`, `null`) means no rewind.
- **`resumeWithoutRewind()` is the skip path** for automatic resumes (auto-resume, later tickets). It
  sends `play` only and does nothing while the Lesson is playing.
- **A Lesson that ended does not rewind.** `play` after the end restarts the Lesson; a step back first
  would land it near the end instead.
- **A Lesson paused at its start** (autoplay refused) needs no special case: the rewind clamps at 0.
