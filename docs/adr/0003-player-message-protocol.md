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
  start it"), so the learner is not left facing a silently stopped video.

- **`error`** is posted once per Lesson, whether the stream or the media element failed first.
  After it the player posts nothing more for that Lesson and pauses it.
- **`timeUpdate`** is posted on the media element's `timeupdate`, and also once the Lesson's
  length becomes known (`durationchange`). The extension therefore has the length before the
  Lesson plays, even when autoplay is refused. `timeUpdate.duration` is 0 while a MediaSource
  stream's length is not yet known, so both numbers are always finite.
