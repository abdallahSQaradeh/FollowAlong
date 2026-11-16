# Marking and resetting Progress by hand: a reset entry instead of a deleted one, and one marking path

Spec #12 (stories 88 and 89) lets the learner mark every Lesson of a Section done (_Mark all done_),
reset a Section (_Reset Section_) and the whole Course (`FollowAlong: Reset Course progress`,
after a confirmation), without touching Resources or prepared sound. ADR 0010 and ADR 0030 say how Progress
is kept and merged; these are the choices they leave open (#30). #29 (one Lesson done or not done)
reuses the marking path below.

## The rules

- **A reset writes a reset entry; it never removes one.** Two copies of `progress.json` (the
  Course's and the fallback, ADR 0005, ADR 0010) and, from #27, two windows are merged per Lesson,
  newest `savedAt` wins. A removed entry would come back from the copy that still has it, so a reset
  would only last until the next merge. A reset entry is `{ position: 0, duration: 0, savedAt }`
  with no `status`: it reads as not started and resumes at 0:00, like a Lesson never played. The
  file keeps one entry per Lesson ever played, as before.
- **Every by-hand change is stamped after the entry it replaces.** `savedAt` is the clock's time, or
  one millisecond after the replaced entry's when the clock has not moved (or went back), so the
  change wins the merge even within the same millisecond.
- **Reset Course also resets `last`.** `last` is the Lesson the Course reopens on (ADR 0010) and is
  merged the same way. It is replaced by one with an empty `lessonId` (`noLastLesson`), which names
  no Lesson, so the Course reopens on its first Lesson from 0:00, as a Course never played does.
  Reset Section leaves `last` as it is.
- **Mark all done keeps what is saved.** A Lesson gets `status: 'done'` with its position and length
  as they were, so a Lesson half-way keeps its place (it resumes 5 s before it) and one never played
  gets a done mark at 0:00 (it starts at 0:00, ADR 0030). `last` is not changed: nothing was played.
- **A Section means its nested Sections too**, as its `3/12` in the tree does (ADR 0043).
- **Resources and prepared sound are not read or written** by any of this: only `progress.json` changes
  (a Seam 1 test checks `resources.json` and a prepared sound file byte for byte on disk).
- **D5 and its amendment apply as for every Progress write** (spec #12): a progress file that cannot
  be read is never overwritten; the change goes to the fallback storage, and reads take the newest
  per Lesson across both locations.
- **The Lesson that is playing starts its 10 s of play again** when a reset covers it
  (`LoadedLesson.progressCleared`). Otherwise the next `timeUpdate` would record it with the play
  counted before the reset and show it as in progress again within a quarter of a second. Its
  position is recorded again as it plays on, like any Lesson the learner is watching; only what was
  saved before is reset. A reset does not unload the Lesson or stop it.
- **Reset Course progress asks first; Reset Section does not.** The ticket asks for a confirmation
  only for the Course. The question is a notification, like the others (`UiSink.ask`, not modal), so
  the Course and its Progress are fixed when the command runs (ADR 0024). Closing the question or
  declining changes nothing. If another Course was opened while it was open, nothing is reset and
  the learner is told so (the answer was about the Course they saw).
- **Commands that need a Course are refused while one is opening**, with the same message as the
  other commands (`refusedWhileOpening`); a Section the open Course does not have, or no Course
  open, is logged (Section) or said (Reset Course progress) and changes nothing.

## The marking path

`ProgressRecorder` gets `markDone(lessonIds)`, `reset(lessonIds)` and `resetAll()`, which change
what is known in memory and are written by the next `save`. In `createFollowAlong`
(`follow-along.ts`), `markLessonsDone(recorder, lessonIds)` and `resetLessons(recorder, lessonIds)`
apply one to the Lessons given by id, and `showAndSave(recorder)` lets the tree show it
(`refreshTree`, ADR 0044) and resolves once it is saved. Reset Course progress calls `resetAll` and
`showAndSave` itself, since it also resets `last`. The Section commands resolve a Section to its
Lessons and call the first two. #29's single-Lesson commands go next to them in the same function
and call the same two with one id (a "mark not done" is `resetLessons` for one Lesson, unless #29
decides it should keep the position).

## Considered options

- **Delete the entries on reset.** Rejected: the merge would bring them back (above).
- **A `resetAt` mark for the Course, so older entries count as reset.** Rejected: a new version of
  the file and a second merge rule, for what a reset entry already does.
- **Mark all done sets the position to the end.** Rejected: it would lose where the learner was in a
  Lesson they may still want to watch.
- **Confirm Reset Section too.** Rejected: not in the ticket, and it resets one Section's marks, not
  the Course.
