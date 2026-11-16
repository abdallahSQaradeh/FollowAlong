# Auto-pause resumes after a quiet period, and plays through once the learner plays

#60 adds what ADR 0052 left for later: with `pauseAndResume`, a Lesson that typing paused goes on
by itself once the learner stops typing (story 99), and the learner's own play of it lets typing
play through (`overridden`, story 102). `stepAutoPause` stays pure, and the Loaded Lesson keeps the
timer on the Clock port. These are the choices spec #12 left open. Sources: #60 and its routed
notes, ADR 0049, ADR 0052, ADR 0092, and the orchestrator's rulings on the #60 plan (D15 on #12).
The setting's name is ADR 0089.

- **The quiet period runs exactly while auto-pause holds a pause it caused in `pauseAndResume`.**
  The step function derives `startQuiet` and `cancelQuiet` from that one rule, so every way out of
  `autoPaused` (the learner's pause, a play, the Lesson's end or change, the setting) stops it, and
  switching from `pause` to `pauseAndResume` during an auto-pause starts it. Each edit starts it
  again. Its length is read when it starts, so a changed setting counts from the next edit.
- **Auto-resume is the core's own `play`, with no `seekBy`** (story 103): Rewind is for a resume by
  hand (ADR 0016).
- **`played` has a source.** The Loaded Lesson knows what it asked for: the play/pause command's
  `play` is the learner's, auto-pause's resume is `autoResume`, a `load`'s autoplay is `autoplay`
  (a picked or next Lesson, a moved, restored or reloaded page), and a play nobody asked for is the
  learner's click or the native controls.
- **Only the learner's play that ends an auto-pause makes it `overridden`** (D15). The spec says
  "a manual play while armed sets `overridden`". Read literally, almost every play is one (the
  first play after a Course reopens paused, a play after the learner's own pause), and auto-pause
  would then act only after an autoplay, which defeats stories 99 and 102. So a learner's play from
  their own pause, on a fresh Lesson, or after a reopen stays `armed`; auto-pause's own resume and
  an autoplay end its pause as `armed` too, so the next edit pauses.
- **`overridden` lasts until the next pause of any kind**: the learner's, one the player reports
  (a refused play, for one), the Lesson's end, or the learner leaving it. Then it is `armed`. A
  move or reload that lets the Lesson play on in the new page is no pause, so it keeps the
  Play-through (review of #60).
- **It resumes only from the page that holds the pause.** A move (ADR 0049), a reload, or a
  collapse (ADR 0092, which leaves no page at all) replaces that page. A new page has had no click,
  so VS Code would refuse a `play` there (#12 D3). So the auto-pause is dropped rather than
  deferred: the Lesson stays paused as a plain pause, without "Paused (typing)", and a restored or
  moved page loads it paused. A quiet period that ends while no ready page holds the Lesson, or
  before the player has reported the pause, is dropped the same way. One that ends while the
  learner's `play` is on its way does nothing: that play's answer makes the Play-through, or, if
  VS Code refuses it, a plain pause (review of #60).
- **A refused auto-resume ends the auto-pause.** The pause that answers it is a plain pause, and
  the learner is told once to press play in the player, as for any refused play (ADR 0052,
  Consequences).
- **The learner's pause is never resumed** (story 101): it takes auto-pause back to `armed`, and
  only `autoPaused` resumes. A late `paused {byUser: true}` from an earlier `load` is not about the
  Lesson (the `shownLesson` guard), so it does not end the auto-pause.
