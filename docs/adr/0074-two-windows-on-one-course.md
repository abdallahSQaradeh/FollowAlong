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
the Course opened with it (ADR 0005, ADR 0010). Reads already take the newest per Lesson across
`.followalong` and the fallback (ADR 0010), so nothing changes there.

The Resources follow the same rule. Their changes already re-read the file first (ADR 0039), and
detaches are kept as times, so the merge never brings a detached Resource back.

## The two windows take turns, through a lock file

A re-read is not enough when two windows save at the same moment. Each reads the file before the
other renames its new copy over it, and the rename that lands last drops the other window's Lesson.
A Seam 1 test shows this on every run. A lock inside one process would not help, because two
windows are two processes. So the File system port gained `lock(path)`. The Node adapter:

- makes `<file>.lock` beside the file, with exclusive create (`wx`), and removes it once the write
  is done;
- waits while another window holds it, in 20 ms steps for at most 2 s;
- takes over a lock whose file is 10 s old or more, which only a window that stopped mid-write
  leaves behind (a write takes milliseconds);
- on Windows, takes `EPERM` while the lock file still exists to mean held, not read-only (a file
  being removed refuses to be made again).

The store makes the folder, takes the lock, reads, merges and writes, then gives the lock back. A
lock that cannot be made because the location is read-only or gone fails the write the same way
the write would (fallback, or "the Course folder is missing"). A lock still held after the wait is
logged, and the write goes ahead without it: a save is never lost to a stuck lock. Waiting and
the age check use real time in the adapter, like the rename retries of ADR 0005, so Seam 1 tests
on the real file system contend for real.

## A Lesson's status and place merge separately

Newest-wins on whole entries loses a done mark. Window A marks a Lesson done. Window B is still
playing it with the entry it read earlier, and saves its place a moment later. B's entry is newer,
so A's done mark would go (#26 left this to #27, ADR 0030). So an entry now has two stamps:

- `savedAt`: when its place (`position`, `duration`) was saved;
- `statusAt`: when its status was last set, by play crossing a threshold (10 s of play, the last
  5 %, `ended`), or by hand (mark done, reset). An entry without it is read as `savedAt` when it
  has a status, else as never (0). It is written only when it differs from that.

Merging two entries of one Lesson takes the place with the later `savedAt` and the status with the
later `statusAt`; the first copy wins a tie. Every change is stamped after the entry it replaces,
recorded play included (`savedAfter`, ADR 0061). A window's own last write comes back at its next
write, through the re-read, and must never win over what that window did since.

| Case                                                                                                     | Result                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A marks done; B, playing on with its older entry, then saves its place                                   | done, at B's place                                                                                                   |
| A marks done while B's place is newer than anything A read                                               | done, at B's place (mark done changes only the status)                                                               |
| A resets; B then writes a place stamped before the reset (B's write landed late, or B's clock is behind) | reset: 0:00, not started                                                                                             |
| A resets; B then saves a place stamped after the reset                                                   | B's place counts again; the status stays reset until B's play sets one                                               |
| B still had the Lesson done when A reset it, and B saves a newer place                                   | B's place, not done: B's done mark is older than the reset                                                           |
| A resets the whole Course                                                                                | every Lesson of the Course gets a reset entry, also those only B saved, and `last` is reset even when A knew of none |

A reset still writes a reset entry rather than removing one (ADR 0061). It now carries `statusAt`
too, so it beats an older done mark in the other copy.

## Two machines on one share

`savedAt` and `statusAt` are each writer's own clock. On one machine the two windows share it. A
Course on a network share written from two machines compares two clocks. Within their skew the
machine whose clock is ahead wins, and no correction is attempted (orchestrator note 4 on #27:
keep it simple). The lock's age check compares the share's file time with the local clock. A large
skew can make a live lock look left behind (then a rare lost update, as without a lock) or a dead
one look fresh (then each save waits 2 s and goes ahead).

## Considered options

- **The higher status wins** (done over in progress over not started). Rejected, as in ADR 0030:
  an un-mark (#29/#30) would be undone by an older copy.
- **Newest whole entry, plus "done is sticky across a merge".** Rejected: B's play could not tell
  A's reset from a done mark it never saw, so a reset would lose to B's stale done mark.
- **A lock only inside the process.** Rejected: two windows are two processes. It would make the
  test pass and leave the real race.
- **No lock, documenting the gap.** Rejected: the gap was not rare in tests (a queued save of the
  other window landing during a reset), and a window's last save before closing would not heal.
- **Raise `progress.json` to version 2.** Not done: `statusAt` is optional, and an older v1 reader
  ignores it. It then writes entries without it, which read as before.

## Consequences

- `.followalong` (or the fallback folder) holds `progress.json.lock` or `resources.json.lock` for
  the few milliseconds of a write. A crash can leave one behind for up to 10 s. Auto-pause ignores
  them like any file there (ADR 0052).
- `ProgressRecorder.resetAll` takes the Course's Lesson ids.
- Saves of entries whose status was set before their place carry `statusAt`.
