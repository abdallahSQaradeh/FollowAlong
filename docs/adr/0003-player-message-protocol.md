# The player message protocol: tagged unions, validated on both sides

The extension and the player talk only through `src/protocol/player-messages.ts`: `PlayerCommand`
(extension → player) and `PlayerEvent` (player → extension) are unions tagged by `type`, with the
names and fields of spec #12 (`load {lessonId, videoUri, container, startAt, autoplay}`, `play`,
`pause`; `ready {aacSupported}`, `timeUpdate {position, duration}`, `played`, `paused {byUser}`,
`ended`). Both sides parse what they receive with `parsePlayerCommand` / `parsePlayerEvent` and drop
anything malformed, because a message crosses a process boundary as plain JSON. Later tickets add
the spec's other messages to these unions and parsers.

Two deliberate additions to the spec's shapes:

- **Every event about a Lesson carries its `lessonId`.** Events are asynchronous: a `timeUpdate`
  of the previous Lesson can arrive after the extension sent `load` for the next one, and Progress
  must not be saved against the wrong Lesson.
- **An `error {lessonId, message}` event.** A WebM that MediaSource cannot parse, or a file the
  webview cannot fetch, would otherwise fail silently; the core logs it and shows the learner one
  message.

## Event meanings

- **`played`** is posted on the media element's first `playing` event after a load or a pause.
  `play` fires before any media is ready, even for a file that then fails. A stall that recovers
  is not a new `played`.
- **`paused.byUser`** is false when:
  - the extension asked for the pause, including a `pause` whose event a following `load`
    cancelled (the flag is reset on `load`);
  - the Lesson ended (Chromium fires `pause` before `ended`);
  - autoplay was refused (`play()` rejected with `NotAllowedError`).

  A `paused {byUser: false}` before the Lesson ever played, after a `load` with `autoplay`, means
  VS Code refused autoplay. The core then shows an info message ("Press play in the player to
  start it"), so the learner is not left facing a silently stopped video. The same answer to a
  `play` the core sent from the play/pause command is told too (ADR 0008).

- **`error`** is posted once per Lesson, whether the stream or the media element failed first.
  After it the player posts nothing more for that Lesson and pauses it.
- **`timeUpdate`** is posted on the media element's `timeupdate`, and also once the Lesson's
  length becomes known (`durationchange`). The extension therefore has the length before the
  Lesson plays, even when autoplay is refused. `timeUpdate.duration` is 0 while a MediaSource
  stream's length is not yet known, so both numbers are always finite. For a WebM without a
  Duration element (a screen recording) that lasts until the whole file has streamed.
- **`seeked`** is posted on every `seeked` of the media element: a seek command, a seek bar drag,
  and also the seek that applies a `load`'s `startAt`, which carries `startSeek: true` (every other seek carries `false`; ADR 0030). It
  carries no position: the media element fires `timeupdate` before `seeked`, so a `timeUpdate` at
  the new position always arrives first (Seam 2 checks the order), and the core reads it there.
- **`userInteracted`** (no `lessonId`) is posted when the learner finishes an interaction with
  the player page: a click on the picture, a key, a native control, or the release of a
  seek-bar drag (never during it). The extension then hands focus back (ADR 0009).

Ticket #17 added `seekBy {seconds}` (extension → player, signed) and `seeked` (player → extension, with
`lessonId`); see ADR 0013.

Ticket #18 added `setRate {rate}` (extension → player) and `rateChanged` (player → extension, with
`lessonId` and `rate`); see ADR 0015.

Ticket #21 added `showNext {title}` (extension → player) and `nextClicked {lessonId}` (player →
extension); see ADR 0019.

Ticket #26 added the optional `startSeek` flag to `seeked` (player → extension); a `seeked` without it
is read as before (ADR 0030).

Ticket #19 added `setResumeRewind {seconds}` (extension → player, 0 or more); see ADR 0016.

Ticket #33 added `loadId` (a whole number) to `load`, and the player echoes it on every event
about the Lesson (`timeUpdate`, `played`, `paused`, `ended`, `seeked`, `rateChanged`, `error`,
`nextClicked`). The extension counts its loads and acts on an event about a Lesson only when its
`lessonId` and its `loadId` are those of the current load. The `lessonId` alone stopped being
enough when one player page started to outlive a Course (ADR 0022): two Courses can both hold
`01.mp4`, and a late `timeUpdate` or `ended` from the first one would count for the second. It is
optional on both sides, so a `load` without it gets events without it.

Ticket #41 added `soundReady {audioUri}` and `soundFailed {message}` (extension → player), for the
audio sidecar of an MP4 Lesson when the page cannot decode AAC; see ADR 0034. `load` has no
`audioUri`: the sound always comes with `soundReady`, after the `load` it belongs to.

Ticket #46 added `zoom {action}` (extension → player; `reset` only, until #48) and
`zoomChanged {level}` (player → extension, without `lessonId`: zoom belongs to the page); see
ADR 0037.
