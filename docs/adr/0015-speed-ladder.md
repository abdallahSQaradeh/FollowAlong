# Speed ladder: the core steps a fixed ladder and sends `setRate`; the rate stays across Lessons

Spec #12 (story 41) gives the speed commands a fixed ladder, 0.75×, 1×, 1.25×, 1.5×, 2×, and leaves
the mechanics open. These are the choices, following the pattern of ADR 0013 (a command in, a
player message out, nothing read until the key is pressed).

- **The core owns the ladder, the player owns the rate.** `speedStep(direction)` finds the rung one
  step above or below the current rate and sends `setRate {rate}` with an absolute rate. Unlike a
  seek, a rate has no moving target, so an absolute value is safe. The ladder stops at 0.75× and
  2×: a press at an end sends the end rate again, which changes nothing and keeps the player in
  step if it ever drifted.
- **The core tracks the rate.** It takes it from `rateChanged {lessonId, rate}`, and also counts
  its own `setRate` at once, so presses in a row climb a rung each before the player has answered
  the first. It remembers the rates it asked for and not yet heard back: the answer to a press
  settles that press and the ones before it, so a late answer never undoes later presses, while a
  rate nobody asked for replaces them. The rate belongs to the player, not to a Lesson, so the core
  does not drop a `rateChanged` from another Lesson. The player reports every change, whoever made it, including a rate picked in the
  video's own menu, so the core never works from a stale number. It starts at 1 and starts again
  at 1 when the player page reports `ready` (a new page plays at 1).
- **A rate between rungs** (1.1×, from the video's own menu) steps to the next rung in the
  direction pressed: up goes to 1.25×, down to 1×. A rate beyond the ends comes back onto the
  ladder: up from 3× goes to 2×.
- **The rate stays from Lesson to Lesson.** A new `src` resets `playbackRate` to
  `defaultPlaybackRate`, so the player sets both. The learner who picked 1.5× keeps it for the
  next Lesson (stories 41 and 71: one speed for the Course, not one per Lesson). The rate is not
  saved across VS Code restarts or new player panels; a new panel plays at 1×.
- **Protocol.** `setRate {rate}` (extension → player; a finite number above 0, else ignored) and
  `rateChanged {lessonId, rate}` (player → extension). The spec lists `rateChanged` without
  fields; it carries `lessonId` like every Lesson event so a late event is recognisable. The player
  posts it only when the rate changed, because a change of `defaultPlaybackRate` also fires
  `ratechange`.
- **Keys and Palette.** `Ctrl+'` `↑` / `↓` (`Cmd+'` on macOS, best-effort) with the same `when` as
  the other chords. The commands are `FollowAlong: Speed up` and `Speed down`.
- **Before there is something to speed up,** the commands say "no Lesson is open" or do nothing
  while the page starts, as play/pause and the steps do.

## Considered options

- **Only the player knows the ladder (`setRate {direction}`).** Rejected: the ladder is a rule of
  the Follow-along loop, so it belongs where Seam 1 reaches it, and #22's status bar shows the rate
  from the core.
- **Not sending at the ends of the ladder.** Rejected: nothing is gained, and a re-send fixes a
  rate that drifted.
- **Reading the rate only from `rateChanged`.** Rejected: two quick presses would both start from
  the same rung.
