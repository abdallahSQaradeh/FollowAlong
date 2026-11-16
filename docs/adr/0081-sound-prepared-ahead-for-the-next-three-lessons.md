# Sound prepared ahead: the next 3 Lessons, one at a time, in the core

Ticket #44 (user story 68). ADR 0034 converts a Lesson's sound when it is opened, so the learner
waits at the first frame of every MP4 Lesson. The core now also prepares the sound of the Lessons the
learner is about to open, so moving on is instant. The rules live in one core module
(`src/core/sound-queue.ts`) behind `SidecarSound.prepare` and `prepareAhead`; adapters only run what
they are told.

- **The queue.** The opened Lesson first, then the next 3 in Course order, one conversion at a time.
  "The next 3" are the next 3 _places_ in Course order: a WebM among them is a place that needs no
  work, and the Lesson after the 3 is not prepared until the learner is closer. Nothing starts ahead
  while the opened Lesson's sound is being prepared; the queue is idle for a Lesson that needs none.
- **Opening another Lesson reorders.** Work for Lessons no longer among the next 3 is stopped through
  the existing abort signal, and the new Lesson goes first. A Lesson whose conversion is already
  running ahead is not stopped and not started again when the learner opens it (opening the next
  Lesson is the common case): the opened Lesson waits for that same conversion and shows its progress.
  A conversion ahead for a Lesson still wanted, but not first, is stopped only to give the opened
  Lesson its turn, and starts again from the beginning in its own turn (ffmpeg cannot resume). Two
  Lessons still wanted ahead never pre-empt each other: the one running finishes first.
  The next run starts when a stopped one has been told to stop, not when its ffmpeg has exited: a
  stopped ffmpeg may take up to the kill grace of ADR 0056 to go, and the opened Lesson must not wait
  for it. A stopped job is never started again before its own old run has ended.
- **What is skipped.** A Lesson converted before (the cache name of ADR 0034: relative path, size
  and last change) costs no conversion; a WebM, a silent MP4 and an MP4 whose sound the page decodes
  (`ready.soundCodecs`, ADR 0056) are found out by the same probe the opened Lesson goes through, so
  one rule decides it for both. Nothing is prepared ahead when the page plays AAC itself. A Lesson
  looked at once is not looked at again until the learner opens another Lesson, which finds a sound
  taken away since (cleared by hand, pruned by ticket #45) and a Lesson file that changed.
- **A failure ahead is silent.** When the probe or the conversion fails, or the 30 s probe / 60 s
  no-progress timeouts of ADR 0056 fire, for a Lesson that is not the opened one: one line in the log
  (warn), no message, no overlay, no status bar item, and the queue goes on with the next. The Lesson
  is not tried again ahead of time in this window (no loop of 60 s waits); opening it tries again, and
  then it is the opened Lesson, whose failure the learner sees with _Play without sound_ (ADR 0055).
- **Low process priority.** `ConversionRequest.lowPriority` is the hint, and the core sets it for
  every conversion, not only those ahead: a conversion that was running ahead when the learner opened
  its Lesson would otherwise keep the priority it started with, and ffmpeg at below-normal priority on
  an idle machine is as fast as at normal. The Node adapter applies it with `os.setPriority(pid,
PRIORITY_BELOW_NORMAL)` right after the process starts (a nice value on macOS and Linux,
  `BELOW_NORMAL_PRIORITY_CLASS` on Windows). A system that refuses never fails the conversion. The
  probe is a short read and keeps normal priority.
- **Where the sound goes** is unchanged: Course data (`.followalong/sound`), or the fallback storage
  of a read-only Course (ADR 0034, story 107). Pruning belongs to ticket #45; this one only adds
  files with the existing names.
- **Seam 1 covers it** (`test/unit/sound-ahead.test.ts`): the fake converter and a real temp-dir
  file system show the order, the one-at-a-time rule, reordering, pre-emption, the skips, the silent
  failures and the priority hint. The adapter's use of the hint is checked in D11's existing converter
  test (`test/unit/ffmpeg-converter.test.ts`), with the system call stood in for.

Source: spec #12 (_Sound for MP4 Lessons_, story 68); ticket #44 acceptance criteria; the
orchestrator's routed notes for #44 (queue in the core; a failure ahead logs one line and skips; the
priority hint through `ConversionRequest`; the adapter test as D11's only exception; #45 owns
eviction).
