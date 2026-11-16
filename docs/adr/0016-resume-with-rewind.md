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
- **A click on the picture is a manual resume too, and the player applies it.** #23 handles that
  click inside the player, so the core never sees a `play` to put a `seekBy` before. The core stays
  the one owner of the setting: it sends `setResumeRewind {seconds}` and the player, on a click that
  resumes a paused Lesson, steps back by that many seconds (clamped at 0) and plays. It does nothing
  for a click that pauses, or for a Lesson that ended. (Source: orchestrator answer, ticket #19,
  "manual resumes … click".)
- **When the core sends it.** After the player page reports `ready` and whenever the setting
  changes, but only when it differs from what the page holds. A fresh page holds 0, so the default
  setting sends nothing, and a later `load` does not repeat it. The value does not reset on `load`.
- **The page's own control bar is not covered.** Its play button resumes inside Chromium's native
  controls before the page can step back first, so a resume from there does not rewind. Keyboard,
  command and picture click do.
- **A Lesson that ended does not rewind.** `play` after the end restarts the Lesson; a step back first
  would land it near the end instead.
- **A Lesson paused at its start** (autoplay refused) is not rewound: the click path skips the seek
  at 0, so the player reports no `seeked` for a seek that moved nothing. The keyboard path sends the
  `seekBy` anyway, and the player clamps it.
- **A Rewind adds to a seek still under way.** The player's `currentTime` already holds that seek's
  target (ADR 0013), so a resume right after a step back rewinds from the new place.
