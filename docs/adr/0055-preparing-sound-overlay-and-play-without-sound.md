# "Preparing sound… N%" and _Play without sound_: what the learner sees while the sound is prepared

Spec #12 (stories 69, 70 and 72; ticket #42). While an MP4 Lesson's sound is converted (ADR 0034) the
learner sees the first frame under "Preparing sound… N%", and the same words in the status bar. When
preparing fails they see one error and a _Play without sound_ button, so they are never stuck. This
replaces the minimal failure of ADR 0034 (one message box, then the picture plays silently at once).

- **The core owns the numbers, the player draws them.** The Converter's progress reaches the Loaded
  Lesson, which sends `soundProgress {percent}` after the `load` it belongs to (each whole percent once
  per page) and builds the status bar item. Both are Seam 1 observables. A page that reloads
  mid-conversion is told where the conversion is, right after its `load`.
- **It starts when a conversion does.** The audio sidecar service reports 0% once the probe has found
  that the sound must be converted, not before. A silent MP4, a sound the page decodes itself, and a
  sound prepared before show nothing, so they never flash an overlay for the few hundred milliseconds
  their check takes. The price is that a probe which stalls shows nothing until it ends in the failure
  below, 30 s at most (ADR 0056).
- **The status bar item** has the id `sound`, a spinning icon, no command, and the text
  `Preparing sound… N%`. It sits after the back item and goes when the sound is ready, fails, or the
  Lesson is left.
- **Failure is the player's.** The core logs the reason once and sends `soundFailed {message}`: no
  message box any more, because the error is on the picture where the learner is looking, and a second
  one in a corner would be two errors for one failure. A page that reloads is sent it again, and the
  core does not convert again. The status bar item goes.
- **The player waits for the learner.** On `soundFailed` the Lesson moves to a `failed` sound state:
  the notice shows the message and the button, and the native control bar stays hidden (the one shared
  rule of ADR 0034, which the zoom also asks), because its play button would start the picture without
  the sound the learner did not choose to lose. A `play` command, an autoplay, a click on the picture or
  the hotkey does nothing then: the button is the way. A play remembered
  from before the failure is dropped. The learner is told once, over the picture, and chooses.
- **`playWithoutSound`** (player → extension, about a Lesson, additive to ADR 0003). The player moves
  to the `none` state, shows the control bar, plays, and posts it. The video is not muted (ADR 0034):
  its own sound is the AAC the page cannot decode, so it is silent. The core remembers the choice while
  the Lesson stays loaded: a page that reloads is sent `noSidecar` instead of the error again. Leaving
  the Lesson forgets it, so opening it again tries the sound again, which may then work (ffmpeg was
  installed, a drive came back).
- **The overlay dims the frame, it does not hide it** (a 45 % scrim), stops above the native control
  bar like the Next overlay, and lets clicks through to the picture, except on the button. A click on
  the picture while the sound is awaited still means "play when it is ready" (story 70).

## Considered options

- **Show "Preparing sound… 0%" from the `load` on.** Rejected: most MP4 Lessons that need nothing
  (silent, or sound the page decodes) would flash it.
- **Keep the message box as well as the overlay.** Rejected: one failure, one error (story 72).
- **A _Play without sound_ that the play hotkey also triggers.** Rejected: the learner who presses the
  hotkey has not seen the error, and silent playback is what the error exists to avoid.
