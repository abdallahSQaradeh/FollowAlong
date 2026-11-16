# Two windows on one Course: re-read and merge under a lock, status and place merged apart

Spec #12 (story 85, #27) has two VS Code windows on the same Course merge their Progress per
Lesson, newest write wins, so neither overwrites the other. Each window is its own extension host
process with its own Progress in memory, read when the Course opened (ADR 0010). These are the
choices that make that hold.

## Every write re-reads the copy it replaces and merges it

`openCourseData` (`course-data.ts`) reads the file again before every write of a file that has a
`merge` (`progress.json`, `resources.json`), and writes the merge of what it was given with what is
on disk. What it was given wins a tie: it is the newer. `write` resolves with `merged`, so the
caller catches up with what the other window wrote. D5 as amended (spec #12) holds on that re-read
too: a copy that has turned unreadable meanwhile (damaged, or rewritten by a newer FollowAlong) is
never written over. The data goes to the fallback storage and the learner is told once, as when
the Course opened with it (ADR 0005, ADR 0010). A copy that read fine until now and fails to read
outright at a write (an antivirus scan holding it for a moment) is read again, up to 3 times,
under the lock. If it still cannot be read, it is neither written over nor sent elsewhere
(ADR 0010's "a passing lock does not divert saves"). The write rejects with `CourseDataBusyError`,
the Progress store logs it once, keeps the data and saves it at the next save, and the learner is
told nothing. Only a copy that keeps failing goes the fallback way. The one loss left is when the
window's last save, as it closes, meets such a hold: the place since the save before is lost, and a
log line says so. Retries are immediate, with no wait: the core has no real-time wait on the
learner's path (gate return 1 on PR #105). Reads already take the newest per Lesson across
`.followalong` and the fallback (ADR 0010), so nothing changes there.

The Resources follow the same rule. Their changes already re-read the file first (ADR 0039), and
detaches are kept as times, so the merge never brings a detached Resource back.

## The two windows take turns, through a lock file

A re-read is not enough when two windows save at the same moment. Each reads the file before the
other renames its new copy over it, and the rename that lands last drops the other window's Lesson.
A Seam 1 test parks one core between its re-read and its rename (the harness holds that write)
while the other saves. Without the lock it fails on every run. A lock inside one process would
not help, because two windows are two processes. So the File system port gained `lock(path)`.
_Source: orchestrator answer to the #27 consult (lock file accepted, with conditions)._ The Node
adapter:

- makes `<file>.lock` beside the file, with exclusive create (`wx`), and removes it once the write
  is done;
- waits while another window holds it, in 20 ms steps for at most 2 s;
- takes over a lock whose file is 10 s old or more, which only a window that stopped mid-write
  leaves behind (a write takes milliseconds). Each lock holds a token of the window that made it.
  A takeover removes the old lock only if it still holds the token first read, and a window gives
  back only a lock that holds its own token. So a window never removes a lock another window has
  just taken. A lock that cannot be removed is waited on, never taken for a read-only folder. A lock whose token cannot be read is judged by its age alone, and a lock made whose token could not be written (a full disk) is removed at once, so none is left without an owner.
  **Residual case:** two windows that both find the same lock left behind can still both win, in
  one way. The second re-reads the old token after the first has removed the lock, then removes
  the first one's new lock before the first has written its token. That window is the few
  microseconds between a read and a removal. Renaming the old lock away first narrows it no
  further, since the second window's rename can still take the first one's new lock;
- on Windows, takes `EPERM` while the lock file still exists to mean held, not read-only (a file
  being removed refuses to be made again).

The store makes the folder, takes the lock, reads, merges and writes, then gives the lock back. A
lock that cannot be made because the location is read-only or gone fails the write the same way
the write would (fallback, or "the Course folder is missing"). A lock still held after the wait is
logged, and the write goes ahead without it: a save is never lost to a stuck lock and nothing is
shown to the learner. The lock is given back in a `finally`, on every path: a failed write, a
refusal (D5), and before a write falls back to the other location (which takes that file's own
lock). The wait is async and bounded, so the save when the window closes (`deactivate`) takes at
most about 2 s longer than the write itself. Waiting and
the age check use real time in the adapter, like the rename retries of ADR 0005, so Seam 1 tests
on the real file system contend for real.

## A Lesson's status and place merge separately

Newest-wins on whole entries loses a done mark. Window A marks a Lesson done. Window B is still
playing it with the entry it read earlier, and saves its place a moment later. B's entry is newer,
so A's done mark would go (#26 left this to #27, ADR 0030). So an entry now has two stamps:

- `savedAt`: when its place (`position`, `duration`) was saved;
- `statusAt`: when the learner last set its status by hand, or 0 when never. By hand means Mark
  done, Mark not done, Mark all done, Reset Section and Reset Course. Play only ever raises a status
  (none → in progress → done: 10 s of play, the last 5 %, `ended`, ADR 0030) and never changes
  `statusAt`. An entry without `statusAt` is read as `savedAt`: it was written before the field
  existed (every reset of ADR 0061 among them) or by an older FollowAlong, and its whole entry was
  saved then. So it is written only when it differs from `savedAt`, and a status never set by hand
  is written as `statusAt: 0`.

**The status-merge rule (D14 on #12, binding):** of two entries of one Lesson, the one with the
larger `statusAt` gives the status. On equal `statusAt`, the higher status wins (done > in progress

> none): equal stamps mean both rose by play from the same status set by hand (or from never), and
> play only raises. So a newer status set by hand always wins, the furthest play from the same
> baseline wins, and play never beats a status set by hand that it did not see. The place is merged
> apart from the status: the later `savedAt` wins; on the same `savedAt`, the larger position, then
> the longer duration. `last` is the one saved later; on the same `savedAt`, the larger id. No tie is
> broken by which copy came first, so the merge is commutative, associative and idempotent. Copies
> merge to one result whatever the order or grouping of the writes. An exhaustive property test checks
> this (`test/unit/progress-merge.test.ts`: every pair and triple of a domain of status, `statusAt`,
> `savedAt`, position and duration). So does a Seam 1 test of every sequence of up to 3 steps of two windows on
> one Course (`test/unit/two-windows-sequences.test.ts`: mark done, mark not done, play past 10 s, play
> to the end and pause, in either window).

Every change is stamped after the entry it replaces, recorded play included (`savedAfter`, ADR
0061). A window's own last write comes back at its next write through the re-read, and must never
win over what that window did since.

How the rule was reached: a first version stamped play with the time of the raise and made in
progress never replace done. Then a reset followed by play lost to the other window's stale done
mark (gate return 1 on PR #105, HARD 1). It also read a missing `statusAt` as never on entries
without a status, so a pre-#27 reset lost to an older done in the other copy (HARD 2). A second
version kept the stamp over play but let the first copy win a tie. Then a Lesson one window played
to its end lost its done mark to the other window's older play from the same baseline (gate return
2). D14's tie rule closes that.

| Case                                                                                                     | Result                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A marks done; B, playing on with its older entry, then saves its place                                   | done, at B's place                                                                                                   |
| A marks done while B's place is newer than anything A read                                               | done, at B's place (mark done changes only the status)                                                               |
| A marks done; B, which had not seen it, then plays past 10 s and saves                                   | done (A's stamp is newer than B's)                                                                                   |
| A plays 4 s and saves; B plays the Lesson to its end; A saves again                                      | done (equal stamps, 0: the higher status)                                                                            |
| A and B both saw the same reset; A plays past 10 s, B plays to the end                                   | done (equal stamps: the higher status)                                                                               |
| B still has the Lesson done; A resets it, plays it past 10 s and saves; B then saves                     | in progress, at A's place (A's stamp is the reset's, newer than B's done)                                            |
| B still had the Lesson done when A reset it, and B saves a newer place                                   | B's place, not done: B's done mark is older than the reset                                                           |
| A resets; B then writes a place stamped before the reset (B's write landed late, or B's clock is behind) | reset: 0:00, not started                                                                                             |
| A resets; B then saves a place stamped after the reset                                                   | B's place counts again; the status stays reset until B's play raises it                                              |
| `.followalong` holds a reset written before `statusAt`; the fallback holds an older done mark            | reset (the reset's `statusAt` is its `savedAt`)                                                                      |
| A resets the whole Course                                                                                | every Lesson of the Course gets a reset entry, also those only B saved, and `last` is reset even when A knew of none |

A reset still writes a reset entry rather than removing one (ADR 0061). Its `statusAt` is its
`savedAt`, so it beats an older done mark in the other copy.

## Two machines on one share

`savedAt` and `statusAt` are each writer's own clock. On one machine the two windows share it. A
Course on a network share written from two machines compares two clocks. Within their skew the
machine whose clock is ahead wins, and no correction is attempted (orchestrator note 4 on #27:
keep it simple). The lock's age check compares the share's file time with the local clock. A large
skew can make a live lock look left behind (then a rare lost update, as without a lock) or a dead
one look fresh (then each save waits 2 s and goes ahead).

## Considered options

- **The higher status always wins** (done over in progress over not started). Rejected, as in ADR
  0030: an un-mark (#29/#30) would be undone by an older copy. D14 uses it only between equal
  stamps.
- **Newest whole entry, plus "done is sticky across a merge".** Rejected: B's play could not tell
  A's reset from a done mark it never saw, so a reset would lose to B's stale done mark.
- **A lock only inside the process.** Rejected: two windows are two processes. It would make the
  test pass and leave the real race.
- **No lock, documenting the gap.** Rejected: the gap was not rare in tests (a queued save of the
  other window landing during a reset), and a window's last save before closing would not heal.
- **Raise `progress.json` to version 2.** Not done, and the orchestrator confirmed it. `statusAt`
  is optional and additive, so a FollowAlong that knows only version 1 still reads the file. A
  version 2 file would be unreadable to it, and under D5 it would then keep its Progress elsewhere
  rather than write over the file. Such a reader drops `statusAt` when it writes, and the entries
  then read with the default above (a status set at `savedAt`).
  Mixed builds have one more gap. Mark done keeps the entry's old `savedAt` (it changes only the
  status), so a FollowAlong from before #27 merges a newer place from another window over the
  whole entry and drops the done mark. The done mark comes back only if marked again.

## Consequences

- `.followalong` (or the fallback folder) holds `progress.json.lock` or `resources.json.lock` for
  the few milliseconds of a write. A crash can leave one behind for up to 10 s. Like everything in
  `.followalong`, they are not Lessons: the Course model and scanner skip hidden folders, and
  auto-pause ignores FollowAlong's own files (ADR 0052).
- `ProgressRecorder.resetAll` takes the Course's Lesson ids.
- Saves of entries whose status was set before their place carry `statusAt`.
