# Progress marking stays on the Course side of `follow-along.ts`

CP2 (agenda e on #12) looked for a split of `follow-along.ts` that keeps behaviour identical. It moved
out the Course picker command (`course-picker-command.ts`) and the Course hand-off
(`course-hand-off.ts`). It left the six commands that change Progress by hand where they are: Mark
done, Mark not done, the `Ctrl+'` `D` toggle, Mark all done, Reset Section and Reset Course progress
(ADR 0061, ADR 0064).

A module of their own would be shallow:

- The six commands are already methods of `FollowAlong`, so `FollowAlong` would only pass them
  through.
- What they decide with belongs to the Course side, not to marking:
  - the open Course and its `ProgressRecorder`, fixed when the command runs (ADR 0024);
  - the switching guard;
  - the Loaded Lesson, which `progressReset` restarts the play count of;
  - the tree redraw;
  - the confirmation of Reset Course progress.

  That is five callbacks for six methods. The rule itself (stamps, D14) already lives behind
  `ProgressRecorder` in `progress.ts` (ADR 0074), which is the deep module here.

## Considered options

- **A Progress marking module with a host of callbacks.** Rejected for the reasons above: the interface
  would be about as large as the implementation it hides (about 130 lines).
- **The recorder announcing its own resets**, so the core need not call `loaded.progressReset`. Not
  done: it would give `ProgressRecorder` a listener, and it would make the Loaded Lesson depend on
  Progress events, for one call in each of two places.

Revisit when marking gains rules of its own that are not the recorder's, for example a marking command
that asks the learner something per Lesson.
