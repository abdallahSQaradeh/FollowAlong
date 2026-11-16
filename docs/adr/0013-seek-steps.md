# Seek steps: the core sends a signed `seekBy`, the player clamps, a WebM of unknown length is seekable

A Step (see `GLOSSARY.md`) is one keypress that moves the playhead back or forward by the short or
the long step size (spec #12, stories 38–40, 43). The spec leaves the mechanics open; these are the
choices, so the next playback commands (#18 speed, #22 status bar) follow the same pattern.

- **The core decides the size, the player decides the landing.** `seekStep(size, direction)` reads
  `followalong.shortStep` / `followalong.longStep` when the command runs, so a changed setting counts
  on the next press, with no subscription to keep. It sends `seekBy {seconds}` with a signed amount.
  The player adds it to its own playhead (it is the source of truth for the playhead, ADR 0003) and
  stops at 0 and at the end of the Lesson. A step is therefore right even while an earlier seek is
  under way: `currentTime` already holds that seek's target, so steps pressed in a row add up.
- **A bad setting value falls back to the default.** A value that is not a finite number above 0
  (`0`, a negative, `"10"`, `null`) means 5 s or 30 s. The manifest declares `minimum: 1`, so the
  Settings editor flags such values; the core still holds when a hand-edited `settings.json` holds
  one. The core is more lenient than the manifest on purpose: it accepts any positive number, so a
  fraction of a second (flagged by the editor) works.
- **The player reports `seeked {lessonId}`** for every seek that finished, a step or the seek bar,
  as the spec's protocol lists. The extension does not act on it yet; Progress (save on seek) will.
- **Steps take the re-stream path.** The player sets `currentTime` as the native seek bar does, so a
  WebM seek into media the buffer dropped re-streams from the Cluster index (ADR 0006).
- **A WebM without a Duration element** (an unfinalised recording) leaves the MediaSource duration
  Infinity until the stream ends, and Chromium then limits `seekable` to the buffered end: a long
  forward step was cut short without a sound. The player calls `setLiveSeekableRange(0, 24 h)`
  after the first append, so the seek goes through the normal path (the stream runs on to the
  target). When the stream ends, `endOfStream` fixes the duration and the clamp at the end applies.
- **Before there is something to step in,** a step says "no Lesson is open" (same message as
  play/pause) with no Lesson, and does nothing while the player page is still starting.
- **Keys.** Windows/Linux as in the spec. On macOS the one-press keys are `Ctrl+Cmd+←/→`, which
  override the same _Move Editor into Previous/Next Group_ the spec overrides on purpose; Cmd+Alt+←/→
  would, as far as we know from VS Code's macOS defaults, override _Previous/Next Editor_, which
  the spec does not mention. macOS is best-effort (spec #12) and not tested. The chords use `Cmd+'`.

## Considered options

- **The core sends `seekTo` (absolute).** Rejected: the core only knows the last `timeUpdate`,
  a fraction of a second old, and two quick presses would both start from it.
- **One setting object (`followalong.steps`).** Rejected: two plain numbers are what the Settings
  editor shows best.
- **Clamping the forward step at the last `timeUpdate` duration in the core.** Rejected: the player
  owns the playhead and knows the length first.
