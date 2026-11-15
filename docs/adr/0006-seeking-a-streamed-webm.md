# Seeking a streamed WebM: a Cluster index built while streaming, Range re-streams, no Cues yet

WebM Lessons play through MediaSource (research 01). The player streams the file into a
SourceBuffer, and Chromium caps that buffer at about 150 MB, so a long Lesson cannot all be
buffered. When the buffer is full, media far behind the playhead is dropped. A seek back into
dropped media must then fetch it again. Otherwise the native seek bar stalls the Lesson silently,
which gate review 1 of #13 reproduced with a 277 MB file.

`WebmIndex` (`src/player/webm-index.ts`) reads the file's element headers as they stream past. It
records the init segment (every byte before the first Cluster) and each Cluster's byte offset and
start time. Media payloads are skipped, not parsed. `WebmSource` (`src/player/webm-source.ts`)
uses the index like this:

- **Seek behind the stream point to a time no longer buffered.** The Cluster after the target's
  Cluster has already been appended. The player drops the whole buffer, appends the init segment
  again, and streams from the indexed Cluster at or before the target with a `Range: bytes=N-`
  request. VS Code's webview resource loader answers ranges with 206 (research 01). A server
  that ignores the range is handled by skipping the first N bytes.
- **Seek ahead of the stream point** (a start position, or a jump past the download). The running
  stream carries on to the target. While the playhead waits for media, `makeRoom` drops
  everything buffered behind the playhead, then anything ahead of it, so a full buffer never
  waits on a playhead that cannot move.
- **While playing**, `makeRoom` drops only media more than `keepBehindSeconds` (30 s) behind the
  playhead, and otherwise waits for the playhead to move (`timeupdate` or `seeking`).
- **Re-streams run one after another**, and only the latest seek's survives. Each one aborts the
  old fetch (which cancels its reader) and waits for `updateend` before `abort()` and `remove()`,
  so a fast double seek cannot throw `InvalidStateError`.
- **Re-streamed Vorbis.** After a re-stream, Chromium drops the first Vorbis packet, so sound starts
  a few milliseconds after the picture. A pending seek that lands in that gap would never finish,
  so it is moved onto the buffered start (less than 0.1 s away).
- **Failures.** A failed re-stream (fetch, parse or append) ends in the Lesson's single `error`
  event, never a silent stall. A file the index cannot follow (an element of unknown size other
  than a Cluster) also ends in `error`.

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
- two quick seeks back;
- a start position past a full buffer with nothing behind it to drop;
- a failed re-stream reporting `error`.

A forward seek while the network stream lags behind the playhead cannot be reproduced at Seam 2:
Playwright's `route.fulfill` delivers the whole body at once, so the stream never lags. The
start-position test covers the same `makeRoom` path through the simulated quota.
