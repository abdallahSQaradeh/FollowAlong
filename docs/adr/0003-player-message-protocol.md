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

Event meanings: `played` is the media element's `play` event; `paused.byUser` is false for a
pause the extension asked for, for the end of the Lesson (Chromium fires `pause` before `ended`)
and for a refused autoplay; `timeUpdate.duration` is 0 while a MediaSource stream's length is not
yet known, so both numbers are always finite.
