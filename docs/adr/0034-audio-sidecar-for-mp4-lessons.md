# The audio sidecar: an MP4 Lesson's sound as an MP3 beside the video

VS Code's webview cannot decode AAC, the sound of every MP4 Lesson (research #2), but it plays
H.264 and MP3. When the player's `ready {aacSupported}` says it cannot (from `canPlayType`), the
core converts the Loaded Lesson's sound to MP3 with ffmpeg, and the player plays the MP3 in a hidden
`<audio>` beside the MP4. If the page can play AAC, nothing is converted and nothing changes, so a
future VS Code that ships AAC turns this off with no code change (spec #12, ticket #41).

- **Who decides what.** For an MP4 Lesson on a page that said no AAC, the player waits for word of
  its sound, and the core finds out what the sound needs. A sidecar prepared before is used as it
  is. Otherwise ffmpeg reads the file's first sound track (`Converter.soundCodec`):
  - **no sound track:** the core sends `noSidecar`, with no error, and the video plays as it is at
    once;
  - **a codec the page decodes in MP4 itself** (the page reports which of MP3, Opus and FLAC in
    `ready {soundCodecs}`, ADR 0056; VS Code's Chromium has all three): `noSidecar` too, and the video
    plays its own sound;
  - **AAC, or any other codec:** it is converted, and the core sends `soundReady {audioUri}`.

  Every answer goes after the `load` it belongs to, and only while that `load` is the current one.
  A silent or page-decodable Lesson is read again at each open (a short ffmpeg run): nothing is
  stored for it.

- **`load` has no `audioUri`, on purpose.** The spec lists `load {…, audioUri?}`. The sound always
  comes with `soundReady`, also when it was prepared before, so `load` stays synchronous and the
  player has one path. The field is left out of the protocol type (ADR 0003).
- **Where it is kept.** It lives in Course data: `.followalong/sound/`, or `<storage>/courses/<name>-<hash>/sound/`
  when the Course folder is read-only (ADR 0005). The player can read both without a page reload (ADR 0025).
  The file is named `<Lesson file name>-<16 hex of sha256(Lesson path relative to the Course, size, mtime)>.mp3`.
  The next open finds it and converts nothing. A Lesson replaced on disk gets a new name and is
  converted again. Each Course opens its own sidecar store, as its Resources and Progress do. A
  `.followalong/sound/` that was there already but can't be written (the Course turned read-only)
  is found when the converter creates its temp file, which fails with the `readOnly` reason. The
  sound then goes to the fallback storage, with only a log line, as Course data does (story 107).
- **The converter writes the whole file or none.** ffmpeg writes a temp file beside the output, which
  is renamed over it once ffmpeg succeeds. So a file found under the name is always a finished one.
  A cancelled or failed conversion settles only once ffmpeg has exited, and its temp file is then
  removed: on Windows a file a running process holds cannot be. Each run has its own temp name, so a
  new conversion never writes where a cancelled one may still be. A temp file left by a window that
  died mid-conversion is removed by the next conversion in that folder once it is 10 minutes
  untouched (a running ffmpeg writes to its own many times a second). ffmpeg is started with an
  argument array, never through a shell, so a Course path can hold any character. An error the
  learner sees never names the temp file.
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

  A Lesson whose video fails (a codec the page can't play, a broken file) never plays its sound:
  the failure drops the sidecar, and a later `soundReady` or `play` does nothing. A video `play()`
  that is rejected pauses the sidecar that started first.

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
  - **Invariant:** a sidecar plays only where the video's own sound cannot. That needs two
    things: the page says it can't decode AAC (`ready {aacSupported}`, its `canPlayType`, the
    same check behind the player's waiting); and the file's sound, read by ffmpeg, is not one the
    page decodes in MP4 (what it reported in `ready {soundCodecs}`, ADR 0056). So the sound never plays twice: not on an AAC-capable
    page, and not for an MP4 whose sound is MP3 or Opus.
  - Only the Seam 2 harness, which forces "no AAC" in a Chromium that has it, plays both.
- **Failure, until ticket #42.** The learner gets one error message per preparation. The player gets
  `soundFailed {message}` (again after a page reload) and then lets the video play, without sound. A
  Lesson that can never play would be worse. **Replaced by ADR 0055** (ticket #42): the "Preparing
  sound… N%" overlay, and an error with a _Play without sound_ button (`playWithoutSound`).

## Considered options

- **Pause the sidecar on the video's `waiting`, resume it on `playing` (gate round 1, optional).**
  Not done. A local file seldom stalls, and the drift correction realigns the sound within one
  `timeupdate` of the picture moving again. No Seam 2 fixture can stall an MP4 deterministically:
  the harness holds only fetch streams, which MP4 playback doesn't use. The behaviour would go
  untested.
- **An explicit `cwd` for a bare `ffmpeg` (gate round 1, optional).** Not done. The extension host
  runs in VS Code's own folder, not in the learner's files. A bare name is only the stopgap until
  #43 passes the bundled ffmpeg's full path.

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
