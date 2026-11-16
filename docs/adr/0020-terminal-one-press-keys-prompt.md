# The terminal prompt: one question, user settings only, merged never replaced

Spec #12 (stories 44 and 45) asks that the learner can control the Lesson from the integrated
terminal. The `Ctrl+'` chords need nothing from the learner: every keybinding has `terminalFocus` in
its `when` clause, and VS Code's `terminal.integrated.allowChords` (on by default) lets a chord
bypass the shell. The three **one-press keys** (`Ctrl+Alt+Space`, `Ctrl+Alt+←`, `Ctrl+Alt+→`) are
not chords, so the shell gets them unless their commands are in
`terminal.integrated.commandsToSkipShell`. The spec says the core asks once and remembers the
answer. These are the choices it leaves open.

- **The three commands** are `followalong.playPause`, `followalong.seekBackShort` and
  `followalong.seekForwardShort`: the commands bound to a key without a chord. A Seam 1 test reads
  `package.json` and fails if a one-press key is added or removed without the list changing.
- **A notification with two buttons, never a modal.** The UI sink gets `ask(question)`, which
  resolves with `accept`, `decline` or `undefined`. The adapter shows an information message, which
  does not take focus from the code. The core does not wait for it: the Lesson plays at once.
- **Only a button press is an answer, and a window asks at most once.** `accept` and `decline` are
  stored in global state (`followalong.terminalSkipShellAnswer`) and the question never comes back.
  Closing the notification, or letting it go, is no answer: nothing is stored, and the question is not
  asked again in that window, however many Lessons open. The next window (a new activation of the
  extension) asks again. Opening more Lessons while the question is open does not stack questions.
  _Source: orchestrator answer to #24 (PR #78)._
- **Where it asks.** Every time a Lesson is shown in the player, not only for the first Course: the
  first Lesson that opens is the first time, and an answer ends it for every Course and window.
- **User settings only.** A new `TerminalSettings` port (it extends the port list of ADR 0002, as the Logger port did; `Config` is scoped to `followalong.*`,
  and a narrow port for one user setting is safer than widening it to arbitrary settings writes) reads and writes the learner's user-level
  value (`inspect().globalValue`, written to the Global target). The workspace value is never read
  or written: the Practice area is never changed (spec #12, story 20). The value is read when the
  learner agrees, not when the question opened, so edits made meanwhile are kept.
- **The merge.** The commands the learner lacks are appended after their entries, in the order
  above. Nothing is removed, reordered or duplicated, and `-command` entries stay. If the learner
  has all three, nothing is written.
- **A value that is not a list of strings is left alone**, and the learner is told (the rule of #12
  D5: never overwrite what FollowAlong cannot read). A failed write is told once; the answer was
  stored before the write, so it is not asked for again at every Lesson.

## Considered options

- **Ask in a modal dialog.** Rejected: it takes focus from the code, which is the Focus change
  FollowAlong exists to remove.
- **Treat a dismissed notification as a decline.** Rejected: a toast that times out would silently
  end the offer for good.
- **Ask again at every Lesson until answered.** Rejected: a dismissed toast would come back every
  time the learner moves to another Lesson.
- **Write the setting without asking.** Rejected: it changes the learner's own settings (spec #12,
  story 45).

## Consequences

- Until the learner agrees, a one-press key typed in the terminal reaches the shell. The chord forms
  (`Ctrl+'` `Space`, `,`, `.`) always work. This is Manual QA (#64), together with the order of
  events on first run: the key may reach the shell before the prompt is answered.
- Settings changes are visible to the learner as ordinary user-settings edits; the answer is not
  stored anywhere else, so deleting the global state asks again.
