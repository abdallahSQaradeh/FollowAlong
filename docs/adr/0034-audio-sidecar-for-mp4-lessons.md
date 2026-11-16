# The audio sidecar: an MP4 Lesson's sound as an MP3 beside the video

VS Code's webview cannot decode AAC, the sound of every MP4 Lesson (research #2), but it plays
H.264 and MP3. When the player's `ready {aacSupported}` says it cannot (from `canPlayType`), the
core converts the Loaded Lesson's sound to MP3 with ffmpeg, and the player plays the MP3 in a hidden
`<audio>` beside the MP4. If the page can play AAC, nothing is converted and nothing changes, so a
future VS Code that ships AAC turns this off with no code change (spec #12, ticket #41).

- **Who decides what.** The core decides whether a Lesson needs a sidecar (MP4, and the page said no
  AAC), prepares it, and sends `soundReady {audioUri}` after the `load` it belongs to, and only
  while that `load` is the current one. The player makes the same decision for itself and waits for
  the sound.
- **`load` has no `audioUri`, on purpose.** The spec lists `load {…, audioUri?}`. The sound always
  comes with `soundReady`, also when it was prepared before, so `load` stays synchronous and the
  player has one path. The field is left out of the protocol type (ADR 0003).
- **Where it is kept.** It lives in Course data: `.followalong/sound/`, or `<storage>/courses/<name>-<hash>/sound/`
  when the Course folder is read-only (ADR 0005). The player can read both without a page reload (ADR 0025).
  The file is named `<Lesson file name>-<16 hex of sha256(Lesson path relative to the Course, size, mtime)>.mp3`.
  The next open finds it and converts nothing. A Lesson replaced on disk gets a new name and is
  converted again. Each Course opens its own sidecar store, as its Resources and Progress do.
- **The converter writes the whole file or none.** ffmpeg writes a temp file beside the output, which
  is renamed over it once ffmpeg succeeds. So a file found under the name is always a finished one.
  A cancelled or failed conversion settles only once ffmpeg has exited, and its temp file is then
  removed: on Windows a file a running process holds cannot be. Each run has its own temp name, so a
  new conversion never writes where a cancelled one may still be. ffmpeg is started with an argument
  array, never through a shell, so a Course path can hold any character.
- **The program.** The core passes it in `ConversionRequest.program`: the `followalong.ffmpegPath`
  setting when it is a full path, else `ffmpeg` on PATH. An empty setting means "not set". A path
  that isn't full is ignored with one warning per window and value, because it would resolve
  against whatever folder VS Code runs in (as for Courses roots). Ticket #43 changes the default to
  the bundled build. The setting has `scope: machine`, so a workspace, which may be untrusted
  (#12 D1), can never point FollowAlong at a program to run.
- **One conversion at a time, for the Loaded Lesson only.** Loading another Lesson, opening a
  Course with no Lessons, or closing the player cancels it. Picking the same Lesson again, or a page
  reload, keeps it, and the new `load` gets the sound when it is ready. The queue of the next three
  Lessons is a later ticket (spec story 68).
- **The video is the clock.** The player starts the sidecar first and the video once the sidecar
  plays. Without a click in the page, VS Code refuses sound (#12 D3), so a refusal posts
  `paused {byUser:false}`, as a refused autoplay does: one click unlocks playback, as for WebM. The
  sidecar never starts on its own. It follows the video:
  - play and pause, also from the native buttons;
  - `seeking` (the sidecar seeks to the video's position);
  - the rate (the speed ladder, ADR 0015);
  - the volume and mute (below);
  - drift above 0.1 s, checked on each `timeupdate`, but not while the sidecar is still seeking,
    because moving it again would restart that seek.

  The sidecar's own seeks write the `<audio>`'s `currentTime`, never the video's, so they don't go
  through `writeTime` (ADR 0030) and are never taken for the learner's seeks.

- **Waiting for the sound.** While the sound is awaited, the native controls are hidden: their play
  button would start the picture without its sound. The zoom (ADR 0037) also hides the control bar, so one rule
  decides it: it shows only when the picture is not zoomed and no sound is awaited (`showControls` in
  the player; the zoom controls ask `controlsHeldBack`). A `play`, an autoplay, or a click on the picture
  is remembered, and the Lesson starts when the sound arrives (spec story 70). A `pause`, or a
  second click, takes it back.
- **The video is not muted.** This is a reasoned deviation from the spec's literal "MP4 plays
  muted", agreed with the orchestrator. The muting was there to avoid double sound and an
  undecodable track. The invariant below already rules out double sound. So the video keeps the
  learner's volume and mute, and the native slider and mute button show the truth. The sidecar
  copies them both ways on every `volumechange`, and keeps them from one Lesson to the next.
  - **Invariant:** sidecar mode and `ready {aacSupported}` come from one check, the page's
    `canPlayType` for AAC in MP4. A page that can decode the video's own sound never plays a
    sidecar, so the sound can never play twice.
  - Only the Seam 2 harness, which forces "no AAC" in a Chromium that has it, plays both.
- **Failure, until ticket #42.** The learner gets one error message per preparation. The player gets
  `soundFailed {message}` (again after a page reload) and then lets the video play, without sound. A
  Lesson that can never play would be worse. **#42 replaces this** with the "Preparing sound… N%"
  overlay and a _Play without sound_ button (`playWithoutSound`).

## Considered options

- **The video muted, as the spec says literally, with its mute button toggling the sidecar.**
  Built first, then rejected with the orchestrator. The mute icon would show "muted" throughout every
  MP4 Lesson, so the native controls would lie to the learner.
- **The player decides alone, with no core involvement.** Rejected: the Seam 1 tests would not
  reach the AAC skip or the conversion.
- **The core withholds autoplay until the sound is ready, and sends `play` itself.** Rejected: a
  click on the picture during the conversion never reaches the core first. The player has to
  remember it anyway, so the player holds every pending play in one place.
- **Keep the conversion of a Lesson the learner left.** Deferred to the queue ticket, which decides
  which Lessons are converted ahead.
