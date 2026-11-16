# Preparing sound never hangs: the page names the codecs it decodes, the probe times out, ffmpeg is killed

ADR 0034 left three ways for a Lesson's controls to stay hidden for ever, or its sound to play twice.
Ticket #42 closes them (routed from #41, PR #88).

- **The page reports the codecs it decodes in an MP4.** `ready {aacSupported, soundCodecs?}` lists, by
  ffmpeg's names, the ones among `mp3`, `opus` and `flac` for which `canPlayType('audio/mp4;
codecs="…"')` (`mp4a.6B`, `opus`, `flac`) is not empty, as `aacSupported` has always been asked of
  the page. The core hands the set to the audio sidecar service, which no longer hard-codes it: a sound
  with one of those codecs plays its own track, any other is converted. A page that omits the field
  decodes none of them, so every sound is converted and nothing plays twice (the safe side). The
  field is optional, so the protocol change is additive.
- **The probe times out after 30 s.** `ffmpeg -i` on a file on a stalled network mount, or a
  disconnected drive, never answers. The audio sidecar service races the probe against the Clock port
  (so Seam 1 tests it with the fake clock), aborts it, and fails the sound with "ffmpeg did not finish
  reading “<file>” within 30 seconds. Is its drive or network folder still there?", which the learner
  sees with _Play without sound_ (ADR 0055). It does not wait for the converter to settle: a converter
  that ignores its abort cannot keep the Lesson's controls hidden. Leaving the Lesson ends the wait at
  once too. The conversion itself has no timeout: its progress shows, and a stalled one can be left by
  moving to another Lesson.
- **A stopped ffmpeg is killed.** A single SIGTERM does not end ffmpeg while it is blocked in `open()`.
  The Converter adapter now sends SIGTERM when its signal aborts, SIGKILL after 5 s, and gives up
  waiting 5 s after that (a process stuck in the kernel on a dead mount can resist even SIGKILL), so a
  cancelled run always settles. The run still waits for a process that does exit, because on Windows a
  file a running ffmpeg holds cannot be removed.

## Considered options

- **Let the Converter adapter own the probe timeout.** Rejected: only the real adapter could then be
  tested for it, with a real ffmpeg. The core owns the timer, the adapter owns the kill.
- **Probe the codecs once in the player and cache the result in the core.** It already is: the page
  asks once at start and reports in `ready`, which a reloaded page repeats.
