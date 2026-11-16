# Seeking a streamed WebM: a Cluster index built while streaming, Range re-streams, no Cues yet

WebM Lessons play through MediaSource (research 01). The player streams the file into a
SourceBuffer, and Chromium caps that buffer at about 150 MB, so a long Lesson cannot all be
buffered. When the buffer is full, media far behind the playhead is dropped. A seek back into
dropped media must then fetch it again. Otherwise the native seek bar stalls the Lesson silently,
which gate review 1 of #13 reproduced with a 277 MB file.

`WebmIndex` (`src/player/webm-index.ts`) reads the element headers of exactly the bytes that are
appended, so it never runs ahead of the buffer. It records the init segment (every byte before the
first Cluster) and each Cluster's byte offset and start time, kept sorted by offset. A Cluster
seen again after a re-stream is not added twice. Media payloads are skipped, not parsed.
`WebmSource` (`src/player/webm-source.ts`) uses the index like this:

- **A seek to a time that is not buffered.** If the running stream is inside the target's Cluster,
  it appends the target next, and the player waits. Otherwise the target is behind the stream
  (dropped) or in a Cluster known from an earlier stream ahead of it. The player then drops the
  whole buffer, appends the init segment again, and streams from that Cluster with a
  `Range: bytes=N-` request. VS Code's webview resource loader answers ranges with 206
  (research 01); a server that ignores the range is handled by skipping the first N bytes. A target
  before the first indexed Cluster streams from that Cluster.
- **A seek ahead of everything indexed** (a start position, or a jump past the download). The
  running stream carries on to the target. While the playhead waits for media, `makeRoom` drops
  everything buffered behind the playhead, then anything ahead of it, so a full buffer never waits
  on a playhead that cannot move.
- **While playing**, `makeRoom` drops only media more than `keepBehindSeconds` (30 s) behind the
  playhead, and otherwise waits for the playhead to move (`timeupdate` or `seeking`). It does not
  wait when less than a second is buffered ahead: playback would starve before the next append
  fits, so everything behind the playhead may go.
- **Re-streams are queued.** Every seek, even one to a buffered time, supersedes a re-stream that has
  not started. A re-stream that has started is committed:
  - it aborts the old fetch, which cancels its reader;
  - it replaces the buffer;
  - it starts its stream;
  - then it checks the playhead again, since a seek made meanwhile may need its own re-stream.

  Every `appendBuffer` and `remove` first waits until the buffer is not updating, so no two
  operations can overlap (`InvalidStateError`).

- **Re-streamed Vorbis.** After a re-stream, Chromium drops the first Vorbis packet, so sound starts
  a few milliseconds after the picture. A pending seek that lands in that gap would never finish,
  so it is moved onto the buffered start (less than 0.1 s away).
- **A file the index cannot follow**, such as a damaged header or an element of unknown size other
  than a Cluster, still plays: its bytes still go to MediaSource. The index marks itself `broken`,
  and a seek to dropped media re-streams from byte 0 instead (the no-Cues fallback). A target
  ahead of what is buffered waits for the running stream.
- **Failures.** A failed re-stream (fetch, parse or append) ends in the Lesson's single `error`
  event, never a silent stall.

## Considered options

- **WebM Cues + Range for every seek (the first plan).** Our own index already knows every Cluster
  behind the stream point, which is every seek back. Cues would only speed up a forward jump past
  the download point, for example resuming deep into a long Lesson. **Cues are deferred to #25**
  (resume deep into a long Lesson). Without Cues, a forward jump past the download point waits
  for the local stream to catch up. Source: orchestrator answer during #13 gate review.
- **Restart from byte 0 on every unbuffered seek.** Correct, but slow for a seek back near the end
  of a long Lesson, and needless when the offset is known.
- **Keep everything already played.** Impossible past the MediaSource quota.

## Testing

Seam 2 sets `window.followalongPlayerTuning` (`src/player/tuning.ts`, test-only; VS Code never sets
it): small appends, a 3 s "quota" (a buffer holding 3 s is treated as full) and a short
keep-behind window. That makes an 8 s fixture with a Cluster per second
(`test/fixtures/media/long.webm`) behave like a Lesson larger than the quota. The harness answers
Range requests. Tests cover:

- a seek back into evicted media that plays on;
- a second seek back after a re-stream;
- two quick seeks back, the second while the first re-stream is under way;
- a start position past a full buffer with nothing behind it to drop;
- a failed re-stream reporting `error`.

The out-of-order index that gate review 2 found cannot be reproduced at Seam 2. It needs a second
seek while a re-stream sits between a re-seen Cluster and a stale successor, and an 8 s fixture
does not hold that window open. Keeping the index sorted removes the cause.

A forward seek while the network stream lags behind the playhead cannot be reproduced at Seam 2:
Playwright's `route.fulfill` delivers the whole body at once, so the stream never lags. The
start-position test covers the same `makeRoom` path through the simulated quota.
