# The audio sidecar: an MP4 Lesson's sound as an MP3 beside the muted video

VS Code's webview cannot decode AAC, the sound of every MP4 Lesson (research #2), but it plays
H.264 and MP3. When the player's `ready {aacSupported}` says it cannot (from `canPlayType`), the
core converts the Loaded Lesson's sound to MP3 with ffmpeg, and the player plays the MP4 muted with
the MP3 in a hidden `<audio>`. If the page can play AAC, nothing is converted and nothing changes, so
a future VS Code that ships AAC turns this off with no code change (spec #12, ticket #41).

- **Who decides what.** The core decides whether a Lesson needs a sidecar (MP4, and the page said no
  AAC), prepares it, and sends `soundReady {audioUri}` after the `load` it belongs to, and only
  while that `load` is the current one. The player makes the same decision for itself from its own
  `canPlayType`: it mutes the video and waits for the sound. `load` never carries the sound, not even a
  sidecar prepared before, so `load` stays synchronous and the player has one path.
- **Where it is kept.** It lives in Course data: `.followalong/sound/`, or `<storage>/courses/<name>-<hash>/sound/`
  when the Course folder is read-only (ADR 0005). The player can read both without a page reload (ADR 0025).
  The file is named `<Lesson file name>-<16 hex of sha256(Lesson path relative to the Course, size, mtime)>.mp3`.
  The next open finds it and converts nothing. A Lesson replaced on disk gets a new name and is
  converted again.
- **The converter writes the whole file or none.** ffmpeg writes a temp file beside the output, which
  is renamed over it once ffmpeg succeeds. So a file found under the name is always a finished one.
  A cancelled or failed conversion settles only once ffmpeg has exited, and its temp file is then
  removed: on Windows a file a running process holds cannot be. Each run has its own temp name, so a
  new conversion never writes where a cancelled one may still be.
- **The program.** The core passes it in `ConversionRequest.program`: the `followalong.ffmpegPath`
  setting when it is set, else `ffmpeg` on PATH. Ticket #43 changes that default to the bundled
  build. The setting has `scope: machine`, so a workspace, which may be untrusted (#12 D1), can
  never point FollowAlong at a program to run.
- **One conversion at a time, for the Loaded Lesson only.** Loading another Lesson, opening a
  Course with no Lessons, or closing the player cancels it. Picking the same Lesson again, or a page
  reload, keeps it, and the new `load` gets the sound when it is ready. The queue of
  the next three Lessons is a later ticket (spec story 68).
- **The video is the clock.** The player starts the sidecar first and the video once the sidecar
  plays. Without a click in the page, VS Code refuses sound (#12 D3) but would let a muted video
  play: starting the sound first keeps D3's behaviour. Refused sound posts `paused {byUser:false}`,
  as a refused autoplay does. The sidecar follows the video:
  - pause and play;
  - `seeking` (the sidecar seeks to the video's position);
  - the rate (the speed ladder, ADR 0015);
  - drift above 0.1 s, checked on each `timeupdate`, but not while the sidecar is still seeking,
    because moving it again would restart that seek.
- **Waiting for the sound.** While the sound is awaited, the native controls are hidden: their play
  button would start the picture without its sound. A `play`, an autoplay, or a click on the picture
  is remembered, and the Lesson starts when the sound arrives (spec story 70). A `pause`, or a
  second click, takes it back.
- **Mute and volume.** The video stays muted while its sound is the sidecar's, so the native mute
  button can only unmute it. The player takes that press as the learner's mute button for the sound:
  it toggles the sidecar and mutes the video again. The volume slider is copied to the sidecar. The
  learner's mute moves with the sound between Lessons: from the video to the sidecar and back. One
  flaw remains: the button's icon shows "muted" throughout an MP4 Lesson with a sidecar.
- **Failure.** The learner gets one error message per preparation. The player gets `soundFailed
{message}` (again after a page reload) and then plays the video muted. Ticket #42 replaces this
  with the "Preparing sound… N%" overlay and a _Play without sound_ button.

## Considered options

- **The player plays the MP4 unmuted and decides alone.** Rejected: the Seam 1 tests would not
  reach the AAC skip or the conversion. Also, an unmuted video with a track the page cannot decode
  depends on how Chromium treats that track.
- **The core withholds autoplay until the sound is ready, and sends `play` itself.** Rejected: a
  click on the picture during the conversion never reaches the core first. The player has to
  remember it anyway, so the player holds every pending play in one place.
- **Keep the conversion of a Lesson the learner left.** Deferred to the queue ticket, which decides
  which Lessons are converted ahead.
