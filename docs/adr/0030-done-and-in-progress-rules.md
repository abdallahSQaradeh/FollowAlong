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

After a `load` with `startAt` > 0, the player's next `seeked` used to be taken as FollowAlong's own
start seek wherever it landed. When the learner sought while a slow start seek was pending (a large
WebM), Chromium dropped the start seek and fired one `seeked` at the learner's position, and the core
swallowed it: nothing recorded, and a seek into the last 5 % did not mark the Lesson done (review of
#25).

The player now tells them apart. `seeked` carries `startSeek` (ADR 0003):

- During a seek, `currentTime` is its target. The seek whose target is within 0.5 s of `startAt` is
  the start seek (the WebM stream moves a seek less than 0.1 s, ADR 0006); any other `seeking`,
  the learner's included, is not. The last `seeking` before a `seeked` decides, so a learner's seek
  that replaces the start seek is theirs, and a start seek that lands off its target is still the
  start seek.
- The core believes the flag: `startSeek: false` is recorded and saved like any seek, `true` is
  swallowed, wherever the playhead landed.
- A `seeked` without the flag keeps the rule of ADR 0010 and gate review H1: the first `seeked`
  after a `load` with a start position is the start seek, wherever it lands. Nothing in FollowAlong
  omits the flag now; it is the safe reading for a player that does.

This keeps #25's guard against saving a mis-landed start seek (its test is unchanged) and records the
learner's seek. Source: the orchestrator, who asked for player-side tagging over a position
tolerance in the core.

## Considered options

- **A 0.5 s tolerance in the core** (a `seeked` landing farther from `startAt` is the learner's).
  Rejected: a start seek that lands off its target would then be saved as the learner's position,
  wiping the Progress it was meant to keep (gate review of #25, H1).
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
