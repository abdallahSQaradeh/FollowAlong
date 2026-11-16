# Status bar playback items: the core builds the model, a click is one core command, the player reports its closing

Spec #12 (story 47) asks for status bar items for play/pause, current time / length, speed (click to
cycle) and back 5 s (short step), shown only while a Lesson is loaded. The spec leaves the mechanics
open. These are the choices.

- **The core decides what the items say; the adapter only draws.** `buildStatusBar` (in
  `src/core/status-bar.ts`) turns the core's playback record, the playhead, the rate and the
  `followalong.shortStep` setting into a `StatusBarModel`: a list of items, each with an id, an icon
  named by what it shows (`play`, `pause`, `back`; the adapter picks the codicon), a text, a tooltip
  and, when it can be clicked, the name of a core command. The core hands it to the UI sink's new
  `showStatusBar`, and only when it differs from the last one, so the four `timeUpdate`s per second
  cost one update per second. An empty list means no items.
- **What the items show.**
  - Play/pause: a pause symbol while the Lesson plays, a play symbol otherwise (paused, refused
    autoplay, ended).
  - Time: `mm:ss / mm:ss`, as the spec writes it (`12:30 / 40:05`, story 86). Minutes keep counting past 59
    (`65:30 / 90:05`), because Lessons run past an hour. The length reads `--:--` until the player
    knows it (a WebM streamed through MediaSource reports 0 at first, ADR 0003). The time starts
    at `00:00` for every loaded Lesson.
  - Speed: the rate as the core tracks it (`1.25×`), so a rate picked in the video's own menu shows
    too.
  - Back: the short step (`5s`), read from the setting and refreshed when the setting changes.
- **A click is one core command.** The items name a `StatusBarCommand` (`playPause`,
  `speedCycle`, `seekBackShort`), and the adapter runs one VS Code command,
  `followalong.statusBarClick`, with that name. The core's `statusBarClick` maps it to what the
  keys already do (play/pause, back by the short step), so a click and a keypress cannot drift
  apart, and Seam 1 can click an item. The command is not contributed to the Command Palette:
  every control already has its own command (story 46), and this one only carries clicks.
- **The speed item cycles round.** A click moves the rate one rung up the speed ladder (ADR 0015)
  and, from 2×, back to 0.75×, so one item reaches every rung. The keys keep stopping at the ends.
  A rate between rungs (1.1×) goes up to the next rung (1.25×). The core counts it as it counts a
  key press, so clicks in a row climb before the player has answered the first.
- **Loaded means the player holds a Lesson.** The items appear when a Lesson is shown in the player
  and disappear when the learner closes the player tab. For that the Player port gets
  `onDidClose(listener)`, which the panel adapter fires from `onDidDispose` only for the panel that
  is current (not for one that `show` replaced for another Course). On close the core forgets the
  loaded Lesson, the page's readiness and the rate (a new page plays at 1×), and the commands say
  "no Lesson is open" again. Opening a Course that has no Lessons forgets the loaded Lesson the
  same way (found by #20: the commands kept acting on the previous Lesson, and the items would
  have stayed), because the items follow the Course the learner opened. Progress (#25) uses the same event to save when the tab closes.
- **Focus.** A status bar entry takes keyboard focus on a mouse click (VS Code makes its label
  focusable), which would be a Focus change for a control meant to avoid one. After the click
  command the adapter runs `workbench.action.focusActiveEditorGroup`. A status bar click does not
  make the player's group the active one, so this returns to the code. It cannot know when the
  learner was in the terminal: the click then lands in the editor. When the focus return of #23
  (`UiSink.returnFocus()`, which knows editor from terminal) is on `integration/v1`, the click
  command should call that instead.
- **Where.** On the left side of the status bar, in the order play/pause, time, speed, back, with
  priorities that keep them side by side.

## Considered options

- **Clicks run the existing key commands directly** (`followalong.playPause`,
  `followalong.seekBackShort`, a new `followalong.speedCycle`). Rejected: each click would leave
  focus on the status bar, and the speed item would add a Palette command nobody asked for.
- **The adapter holds the label strings.** Rejected: "what to show" is a rule, so it belongs where
  Seam 1 reaches it (CODING_STANDARDS: adapters stay thin).
- **Show the items for a Course as soon as it is open, with no Lesson.** Rejected: the spec says
  they are shown only while a Lesson is loaded, and with no Lesson every item would do nothing.
