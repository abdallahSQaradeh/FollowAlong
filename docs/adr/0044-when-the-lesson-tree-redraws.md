# When the Lesson tree redraws: on a state change or a save, never on every `timeUpdate`

The player reports its playhead about every 250 ms (`timeUpdate`). The core records each report
into the Course's Progress, but the Lesson tree, which shows that Progress (ADR 0043), must not be
redrawn that often: every redraw makes VS Code ask for the whole tree again.

## The rule

`createFollowAlong` draws the tree again (`refreshTree`) only when one of these happens:

1. **A Lesson's state changes** while it plays (not started → in progress after 10 s of play, in
   progress → done at 95 % or the end). The Loaded Lesson notices it when it records a
   `timeUpdate` and calls the `OpenCourseView`'s `progressChanged()`.
2. **Progress is saved:** the 5 s timer while a Lesson plays (this is what moves the
   `12:30 / 40:05` text on), and the saves on pause, seek and end. The text is therefore at most 5 s
   behind the video.
3. **The learner leaves a Lesson**, for another (`playLesson`, so also next/previous and the Next
   overlay) or by closing the player: the Lesson left shows where it was left.
4. **A Resource is attached** (the tree changes).
5. A Course opens (a full draw, as before).

`refreshTree` also compares the new model with the one on screen and skips an identical one, so
saves that change nothing visible (a done or not-started Lesson that plays on) draw nothing.

At most one redraw per save interval while a Lesson plays, plus one per state change: a minute of
play is at most 13 redraws, against 240 `timeUpdate`s. The Seam 1 test counts the draws at the UI
sink and fails if a `timeUpdate` redraws.

## Amends ADR 0024

The Loaded Lesson needed three things from the Course side (`OpenCourseView`). It now needs a
fourth, `progressChanged()`: the Course side owns the tree and the Resources, the Loaded Lesson
knows when a state changed or a save happened, and the tree is a pure function of data only the
Course side holds. A callback was the smallest way to say it (ADR 0024 rejected per-event callbacks,
four or five of them; this is one, called from three places, and not per event).

## Considered options

- **Redraw on every `timeUpdate`.** Rejected: 4 redraws a second of a tree of hundreds of nodes.
- **A second timer for the tree.** Rejected: the save timer already ticks at the interval the spec
  names, and a second one would drift from it.
- **Fire `onDidChangeTreeData` for the one node that changed.** Deferred: the sink replaces the
  whole model, and the extra bookkeeping is not needed at 13 redraws a minute. The adapter keeps
  item ids stable, so VS Code keeps the selection and what is expanded across a redraw.
