# Auto-pause keeps its page count and its snapshot guard

The CP3+CP4 architecture review (#12) looked at the guards the #60 and #61 gates called double: the
Loaded Lesson counts player pages (`pageGeneration`, `autoPausedPage`) and will not auto-resume while
a move waits for the page's `snapshot` (`awaitingSnapshot`), although auto-pause's own
`pageReplaced` input already turns a pause it would resume into a plain one (ADR 0090, #12 D3).
Neither guard goes; each covers a moment `pageReplaced` does not.

- **The page count covers a pause that outlives its page in `pause` mode.** `pageReplaced` keeps a
  `pause`-mode pause, so the status bar keeps saying why the video stopped (ADR 0090). If the learner
  then switches to `pauseAndResume`, the quiet period starts for a pause the new page never held.
  Only `autoPausedPage === pageGeneration` stops the resume. Seam 1 test: _in `pause` mode, a new
  player page keeps the pause it caused › never resumes into the new page when the learner then
  switches to `pauseAndResume`_.
- **The snapshot guard covers the page on its way out.** While a move or a collapse waits for the
  old page's `snapshot`, no new page has started, so `pageReplaced` has not come yet, and a resume
  would play a page that is about to go. Seam 1 test: _never resumes while a move waits for the page
  to say what it shows_.
- **Folding both into the auto-pause state machine was rejected.** The machine would need to know
  which page holds the pause and whether a move is under way. Those are the Loaded Lesson's facts,
  and the machine would take them as extra inputs that only restate them. The two checks sit in
  `canResume`, the one place the machine is asked whether a resume can happen.

Removing either guard fails the named test, so D15's behaviour is pinned at Seam 1.
