# The Progress store: one versioned file per Course, saved as the learner goes, resumed 5 s back

`openProgress(course, ports)` (`src/core/progress.ts`) keeps where the learner is in each Lesson of
a Course. `createFollowAlong` (`src/core/follow-along.ts`) decides when to save and where a Lesson
starts. Spec #12 fixes the broad rules (a progress file in `.followalong\`, keyed by Lesson path,
saved every 5 s and on pause, seek, switch, close and window close, resumed paused at
`max(0, position − 5 s)` (0:00 for a done Lesson saved in its last 5 %, ADR 0030), merged per Lesson with the newest winning). This ADR records the details
it leaves open. #26 (done and in-progress rules), #27 (two windows) and #28 (the tree) build on
them.

## The file

`.followalong/progress.json`, in the envelope of ADR 0005 (`{ "version": 1, "data": … }`), or the
same file in the fallback storage when the Course is read-only:

```json
{
  "version": 1,
  "data": {
    "lessons": {
      "Section 1/01 Intro.webm": { "position": 42, "duration": 600, "savedAt": 1763197200000 }
    },
    "last": { "lessonId": "Section 1/01 Intro.webm", "savedAt": 1763197200000 }
  }
}
```

- **Keys** are Lesson ids (ADR 0007: the path in the Course, with `/`), so moving or renaming the
  Course folder keeps its Progress. The Course itself is keyed by where the file is: in the Course,
  or the fallback folder named by the Course's absolute path (ADR 0005).
- **`position` and `duration`** are seconds, as the player last reported them. `duration` is 0
  while the player does not know it (a WebM without a Duration element, ADR 0006). It is kept now
  because #26 needs a Lesson's length to apply "≥ 95 % starts at 0:00" before the Lesson loads, and
  #28 shows `12:30 / 40:05` for Lessons not opened in this session.
- **`savedAt`** is the Clock port's time of the save, in ms since the epoch. It is what "newest
  wins" compares, per Lesson and for `last`.
- **`last`** is the Lesson whose position was saved last: "the last Lesson played" (story 82).
- A file that does not parse is ignored as a whole, with a log line (ADR 0005): a damaged entry
  means the file was not written by FollowAlong.
- Later versions change the shape by raising `version` and migrating older data in
  `progressFile.parse` (ADR 0005). #26 adds the done and in-progress state this way.

## Two copies

A Course that turned read-only after FollowAlong wrote to it has a stale `.followalong` copy and a
newer fallback copy. `CourseDataFile` gained an optional `merge`; a file that has one is read from
both locations and merged, and `progressFile.merge` takes the newer entry per Lesson and the newer
`last`. Files without `merge` keep the order of ADR 0005. Writes still go to one location (ADR
0005), with everything known, so the copy written last holds every Lesson.

#27 (two windows on one Course) reuses the same merge: re-read the file before each write and merge
it with what this window recorded.

## When Progress is saved

- **Only after the learner engaged with the Lesson:** it played (`played`), or the learner moved
  its playhead (`seeked`). Until then the playhead is where FollowAlong put it, so reopening a
  Lesson and leaving it would otherwise save `position − 5 s`, and every reopen would move it 5 s
  further back.
- **`seeked` has no position.** The player posts it for every seek, including the one that applies
  a `load`'s `startAt` (the same definition as #17). The position is the `timeUpdate` the player
  posts just before it (the HTML seek steps fire `timeupdate`, then `seeked`). After a `load` with
  `startAt` > 0, the next `seeked` is that start seek, wherever it lands: it saves nothing and
  does not count as engagement. An earlier rule (within 0.5 s of `startAt`) saved a start seek
  that a WebM without a Duration landed near 0:00, so the next reopen lost the position (gate
  review of #25, H1; the player now lands it, ADR 0006). Source: orchestrator answer on #25; gate
  review H1.
  **Superseded by ADR 0030:** only a `seeked` within 0.5 s of `startAt` is the start seek.
- **Every 5 s while it plays:** a Clock timer runs from `played` until the Lesson pauses, ends,
  fails or is left. Each `timeUpdate` only notes the position; the timer writes it. A save writes
  only when something was noted since the last one.
- **Right away** on `paused` (any cause; `ended` follows a pause), on `seeked`, when the learner
  plays another Lesson (tree, Go to Lesson…, Next/Previous), opens another Course (only once the
  new folder could be read, so a missing folder leaves the playing Lesson alone), closes the player
  (`Player.onDidClose`, from #22), and when the window closes: `deactivate` returns the core's
  `close()`, which VS Code waits for briefly.
- **Late events of a Lesson left are ignored** from the moment the learner leaves it, so none is
  recorded into the Course opened next. One gap remains: once the next Lesson loads, an event in
  flight from a Lesson with the same id (the same path in another Course) cannot be told apart, since
  the protocol has no load number. The window is the few milliseconds a message takes to cross
  from the player.
- **One open at a time:** Course opens, including the restore at startup, run in the order they
  were asked for, so a Course the learner opens while the remembered one is being restored is the
  one left open (and remembered).
- **One save at a time:** saves are chained, so an older one never lands after a newer one, and
  `close()` and opening another Course wait for every save before them. `close()` also waits for
  an open under way, so the window can close at any step of opening a Course without losing the
  Lesson it left.
- **A progress file FollowAlong cannot read is never written over** (spec #12, D5 as amended by
  the orchestrator: never overwrite it, but do save elsewhere). The Course data store remembers
  each copy it read and could not use (damaged, from a newer FollowAlong, or failing to read).
  When the copy in `.followalong` is such a copy, it is left as it is and Progress goes to the
  fallback storage; `write` reports it (`keptElsewhere`) and the learner is told once per open
  Course: "FollowAlong can't update this Course's progress file: it is damaged, unreadable or from
  a newer FollowAlong, so FollowAlong keeps your progress in its own storage for now." Reads merge
  both copies, so the fallback copy is used (newest per Lesson). When the fallback copy is the
  unusable one, saves go to `.followalong` as usual if the Course is writable. Only when neither
  copy may be replaced does `write` reject (`UnreadableCourseDataError`, ADR 0005): the save is
  skipped and the learner is told "… Nothing was changed." A copy whose read failed outright (an
  antivirus scan holding it) is read again before each write, so a passing lock does not divert
  saves. What it holds then is merged into that write and into this session's Progress, so the
  Lessons the Course opened without are not lost (review of the gate round 1 fixes). The check
  uses what was read; a file another window rewrites during the session is #27's re-read before
  each write. Source: orchestrator, D5 and its amendment; code review and
  gate review of #25.
- **A failed save is saved again** at the next save (the 5 s timer, a pause, a switch,
  `close()`): it is logged once per run of failures and shown to the learner once per open
  Course. A Course moved away while open fails with `notFound` ("the Course folder is missing"):
  `.followalong` is made without its parents (`makeDirectory(path, { parents: false })`), so a
  save never makes an empty Course at the old path. The fallback folder is still made with its
  parents, since it lives in the extension's storage. Source: gate review of #25, S1.

## Where a Lesson starts

- **Opening a Course** with a `last` Lesson that still exists loads it at
  `max(0, position − 5 s)`, paused, with no prompt. A Course with no `last` (never played, or its
  last Lesson was renamed) plays its first Lesson from 0:00, as before.
- **Playing a Lesson** from the tree (and later the Lesson picker, story 33) starts it at
  `max(0, position − 5 s)` and plays.
- **Reopening the workspace** (`onStartupFinished`) opens the Course remembered in the workspace
  storage under `openCourse` (the folder of the last Course opened with Lessons in this workspace).
  Nothing autoplays at startup: a never-played Course opens its first Lesson paused. A remembered
  folder that is missing shows "the folder is missing" once and is forgotten, so the next start of
  the workspace does not say it again; Recent (#35) keeps a moved Course for _Locate…_.

## Considered options

- **Save on every `timeUpdate`.** Rejected: about four writes a second for a file another window
  may also write; the spec asks for every 5 s.
- **`last` is the Lesson last picked.** Rejected: a Lesson picked and never played (autoplay refused,
  D3) would become the one the Course reopens on, and opening a Lesson would write to the Course
  before anything was played.
- **Keep the first location's copy (ADR 0005 order).** Rejected: after a fall back, the next
  session reads the stale `.followalong` copy first (orchestrator notes on #25).
- **Keep Progress in VS Code's global state.** Rejected by the spec: Progress moves with the Course.

## Consequences

- Positions are whatever the player reported last before the save: at most one `timeUpdate`
  (about 250 ms) old, and up to 5 s old after a crash.
- A Lesson whose file is renamed loses its Progress (spec: no fingerprinting).
- A Course in the fallback storage loses its Progress when it moves, because the fallback is keyed by
  the absolute path (spec #12).
