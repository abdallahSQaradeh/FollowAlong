# Done and in-progress rules: a stored status, rules in one pure module

A Lesson gets its Progress state without the learner marking it (spec #12, stories 77, 79, 81).
The rules live in `src/core/lesson-status.ts`, pure, with no player, clock or file in sight. The
Progress store (`progress.ts`) applies them when something is recorded; the Loaded Lesson
(`loaded-lesson.ts`) reports what the player did. #28 (tree), #29/#30 (mark done by hand) and
#32/#36 (pickers) read the state with `lessonStatus(progress, lessonId)` and never re-derive it.

## The rules

- **Not started** until the Lesson has played for 10 s; **in progress** after that. A stray click
  changes nothing.
- **Done** when the playhead reaches 95 % of the Lesson's length or the player reports `ended`,
  also by seeking. A Lesson whose length is unknown (0, ADR 0006) can only be done by `ended`.
- **Done is sticky.** Seeking back, playing on or replaying never clears it; only the learner
  un-marks it (#29/#30). `statusAfter` never returns a lower state than the one before.
- **A done Lesson saved in its last 5 % starts at 0:00.** Any other starts 5 s before its saved
  position (ADR 0010). At `ended` the saved position is the Lesson's length. A done Lesson whose
  length was never known (0: only `ended` could make it done) starts at 0:00 too.

## What counts as 10 s of play

Seconds of picture played, not wall-clock time, summed from the player's `timeUpdate`s while it
plays: the playhead's move since the last one counts when it is forward and at most 3 s. The
player reports about every 250 ms (a little more at 2× or in a background page, up to about 2 s of
picture), so a bigger move is a seek, which plays nothing; a 5 s step forward is not play. Pausing, seeking and loading start the count again from the next
`timeUpdate`. The seconds counted belong to the Lesson while the learner has it open (a player page that
reloads keeps them) and are not saved: 6 s today and
6 s tomorrow do not make a Lesson in progress. Source: the ticket (10 s of play) and the #26
acceptance criteria (scripted `timeUpdate` events); the 3 s limit is ours.

## The file

`progress.json` stays at version 1. Each Lesson's entry gains an optional `status`
(`"inProgress"` or `"done"`; no mark means not started):

```json
"Section 1/01 Intro.webm": { "position": 590, "duration": 600, "savedAt": 1763197200000, "status": "done" }
```

An older v1 file has no `status`, so its Lessons read as not started, with their positions kept.
An entry with any other `status` makes the file unreadable like any damaged entry (ADR 0005). It
stays mergeable: `mergeProgress` takes the whole entry that was saved later, status included, and
the recorder carries a Lesson's status forward when it records a new position. Done in one window
and a later save from another window that never saw it is #27's to settle, by re-reading the file
before each write. The version was not raised: the field is optional, and no released FollowAlong
could write over it.

## A seek while the start seek is pending

After a `load` with `startAt` > 0, the next `seeked` is FollowAlong's own start seek only when it
lands within 0.5 s of `startAt`; `seeked` carries no position, so the position is the `timeUpdate` the
player posts just before it (HTML's seek steps fire `timeupdate`, then `seeked`; ADR 0010). Elsewhere it is the learner's, and it is recorded (and saved) like
any seek, so a seek into the last 5 % marks the Lesson done. Before, any first `seeked` was
swallowed: when the learner sought while a slow start seek was pending, Chromium dropped the start
seek and fired one `seeked` at the learner's position, which was lost (review of #25). This
replaces gate review H1's rule ("wherever it lands"), whose cause was a player that did not land
the start seek on its target. ADR 0006 fixed that, so the rule is no longer needed.

A start seek that landed more than 0.5 s off would be taken for the learner's and saved there,
drifting the Lesson 5 s back at each reopen. The player lands it on its target (ADR 0006), so this
is a player bug to fix there, not to hide here.

## Considered options

- **Tag the start seek in the player** (a field on `seeked`). Rejected for now: it changes the
  protocol and Seam 2, and `webm-source` sets `currentTime` itself when it re-streams, so the player
  cannot tell its own seeks apart cheaply.
- **Keep a done mark across two windows in `mergeProgress` (the higher status wins).** Rejected
  here: the learner's un-mark (#29/#30) would then be undone by an older copy. #27 settles it with
  the re-read before each write.
- **Raise the file version to 2.** Rejected: see _The file_.
- **Count 10 s of wall-clock play.** Rejected: at 2× it is 20 s of picture, and the rules are
  tested with scripted `timeUpdate`s.
- **Derive the state from the saved position alone** (done at ≥ 95 %). Rejected: it cannot be
  sticky, and the learner's manual mark (#29/#30) has no place to live.

## Consequences

- A Lesson the learner un-marks keeps its position in the last 5 %: it opens 5 s before it, and the
  first `timeUpdate` there marks it done again. #29/#30 decide whether un-marking also moves the
  position.
- A Lesson played once for less than 10 s is not started but has a saved position and may be the
  Course's `last` Lesson (ADR 0010).
