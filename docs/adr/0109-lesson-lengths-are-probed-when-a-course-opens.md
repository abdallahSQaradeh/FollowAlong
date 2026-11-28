# Lesson lengths are probed when a Course opens, and kept in their own cache

#132 shows each Lesson's length in the Lesson picker, for Lessons the learner never played too. The
maintainer chose to read the length from the file with ffmpeg (the configured or bundled one, ADR
0071), cache it, and show it for every Lesson, without the picker ever waiting on a probe. These are
the choices the spec leaves open. Source: the #132 triage comment, ADR 0005, 0058, 0070, 0079, 0106.

## When: when a Course is opened, not at the Courses-root scan

- **Two scans, and only one sees Lessons.** The Courses-root scan (`scanCourses`, cached by the
  Course list cache, ADR 0058) stops at the first folder that holds a Lesson file and never lists
  the Lessons. Probing there would mean walking every Course's whole tree and running ffmpeg once
  per video in the library, on network and USB drives too, and again at every Course picker open.
- **The choice.** Lengths are probed in the background when a Course is **opened**, over the
  Lessons that `readCourse` has already listed. One ffmpeg runs at a time, in Course order, with the
  30 s probe timeout of the sound probe (ADR 0081); a failure or a timeout logs one warn line and
  never tells the learner. A missing bundled ffmpeg is said by the Sound notice (ADR 0071), not by a
  length probe. The job stops when the Course is switched or closed, and a result for a Course that
  is no longer open is dropped. A Course with no Lessons starts no job and leaves the cache as it
  was.
- **A timeout stops the job for the rest of the Course.** A drive that stalls on one Lesson stalls
  on the next, and 30 s a Lesson would never end on a large Course. The job logs the timeout once
  and probes nothing more until the Course is opened again. A missing ffmpeg stops it the same way.
  The Lessons it did not reach keep their cached length, unchecked, for the rest of that opening.
- **A cached length shows only while its file is unchanged.** The picker and the tree start from
  the cached lengths at once, then the job checks each Lesson's size and last change in Course
  order. A Lesson whose file changed, is gone (its stat fails, logged as a failed check), or whose
  probe fails (logged as a failed read) shows no length from then on, until a probe finds one: a
  replaced file never keeps showing its old length once the job has reached it.
- **Consequence.** The first time a Course opens, only the Lessons probed so far have a length.
  Opening the Course can be what first says the relative `followalong.ffmpegPath` warning, earlier
  than the first MP4 played; that is accepted.

## Where: the global-storage key `lessonLengths`

- **Its own key**, `lessonLengths`, versioned like the Course list cache (a value of another version
  or shape counts as empty, and a failed write logs one warn and never fails the caller). Entries are
  keyed by the Course folder (`keyOf`, ADR 0083) and the Lesson id, and carry the file's size and
  last change, so a replaced file is probed again. A Lesson ffmpeg reads but reports no length for
  (`Duration: N/A`) is stored as probed and unknown, so it is not probed again. The cache is bounded
  to the Courses opened most recently.
- **Not in `courseListCache`.** That value is dropped whenever the Courses roots change, which would
  throw every length away with it.
- **Never in `.followalong`.** Opening a Course leaves it untouched (ADR 0005), and a length can
  always be found again: it is a cache, not Course data.

## Which length wins, and where it shows

- **A length from Progress wins.** The Progress `duration` is what the player measured; a probed
  length is used only while Progress has none above 0. A length of 0 is unknown, never `0:00`.
- **The Lesson picker** shows `position / length` for a Lesson in progress (as before) and `length`
  for any other Lesson whose length is known, after its Section: `✓ Intro`, `Part  ·  10:00`. An
  unknown length shows nothing, and no placeholder. `buildLessonPicker(course, progress, lengths)`
  takes the lengths found otherwise as a `ReadonlyMap` from Lesson id to seconds, read from the cache
  in the same turn (`KeyValueStore.get` is synchronous), so opening the picker never waits.
- **A probed length also fills `position / length`** for a Lesson in progress whose Progress has no
  duration, through the shared `playheadText` so the picker and the Lesson tree still agree (ADR
  0079, "No second formatter").
- **The open picker fills in lengths as they land.** This amends ADR 0079 (“`UiSink.pick`, not the
  live picker”): the Lesson picker's list is no longer complete at once, so it moves to the live
  picker (ADR 0058) and is updated as probes land.

## Tests

- The core is tested at Seam 1, with the fake converter.
- **The adapter's length probe is tested in `test/unit/ffmpeg-converter.test.ts`**, the recorded
  three-seams exception (D11 on #12, ADR 0057, 0106): only through `createFfmpegConverter`'s port,
  faking only the process and replaying `test/fixtures/probe/*.txt`. This adds cases to that file;
  it is not a new adapter test file, so D11 is not widened (ADR 0070). Parsing ffmpeg's text stays
  in the adapter, and the port speaks in seconds (ADR 0106).
