# Video spots, and moving the video with a snapshot of the player page

#49 lets the video sit in three spots (spec #12, stories 52–56 and 65): an editor group beside the
code (`editorSplit`, the default), the bottom panel (`bottomPanel`) or the secondary sidebar
(`secondarySidebar`). `followalong.videoLocation` names the spot a new player opens in, and
_Move video to…_ moves an open player live, keeping its time, speed, play or pause, and zoom. These
are the choices the spec left open. Source: #49, the routed note from #46 on it, #12 D3/D4/D9, and
the orchestrator's answer to the #49 consult (2026-11-16, 11:59Z), which accepted the defaults
below (Q1–Q4) and added three conditions on Q4: (a) the new page really tries to play, (b) the
snapshot wait runs on the Clock port and never blocks the move, (c) an ended Lesson never
autoplays after a move.

## Where the video opens

- **The setting names where a new player opens** (Q1, Q2: the spec calls it the "default spot",
  and story 55 makes a move a live switch, not a preference). The core reads `videoLocation` when it
  shows a player that is not open (`settingSpot`, `src/core/video-placement.ts`); an unknown value
  is `editorSplit`. While a player is open, every Lesson (next, previous, the pickers, another
  Course) plays in the spot it is in. _Move video to…_ never writes the setting, and a changed
  setting is not acted on at once: like `coursesRoots` (ADR 0022), moving the player under a
  playing Lesson would cost the learner the click that lets it play (#12 D3). A player the
  learner closed opens at the setting again.
- **_Move video to…_ needs a Lesson** (Q3). Without a Loaded Lesson it says "no Lesson is open",
  like the other playback commands. Its quick pick lists the three spots and marks the one the
  video is in (`where it is now`); picking that one, or closing the pick, moves nothing. The
  command also takes a spot as its argument, which the smoke test uses.

## What a move carries, and how

The spec has the player snapshot its state and restore it in the new host. **A webview panel and a
webview view cannot share a page**, so every move starts a new player page. The protocol gains,
additively (Q4):

- **`takeSnapshot` → `snapshot {rate, zoom, lesson?: {lessonId, loadId?, position, playing}}`.** The
  page that holds the video says what it shows: its speed, the zoom view `{level, left, top}` as
  fractions of the picture (ADR 0037, carried as it is), and the Lesson's playhead and whether it
  plays. A Lesson whose start seek has not happened yet answers its `startAt`; one waiting for its
  sound to play counts as playing. A page with no Lesson, or a failed one, answers without one.
  The player is the source of truth for the playhead (spec #12), so the core asks it rather than
  using the last `timeUpdate`.
- **The new page takes over** once it posts `ready`: a `load` at the snapshot's position, with
  `autoplay` if it played (the path a reloaded page already takes, ADR 0030: the start seek is
  FollowAlong's own and saves nothing), a `setRate` when the speed is not 1×, and a new command
  `restore {zoom}`. The page shows that view, keeps it in its own webview state and reports
  `zoomChanged`, as for a zoom the learner made. **`restore` is sent at the whole picture too**
  (review of #49): a view spot keeps the webview state of the page it held before, and that page's
  zoom must not come back.
- **An ended Lesson lands paused at its end** (condition c). A page at the end of a Lesson is
  paused, so its snapshot says it does not play, and so does the core's own record when the page
  does not answer: the new page loads it at its end without `autoplay`. The Next overlay is not
  shown again. The core keeps it ended across the move, and the start seek of the new page does
  not clear that, so the learner's next press restarts the Lesson without a Rewind (ADR 0016),
  or `Next Lesson` moves on (gate review of #49, item 5).
- **A page that does not answer** within 1 s (Clock port, condition b) is moved with what the core
  knows: the last reported playhead, play state and speed; the zoom resets to the whole picture.
  A Lesson loaded with autoplay that has not played yet (its sound may still be preparing) still
  counts as playing, unless it ended (item 6). A page still starting is moved at once, the Lesson
  starting where it was going to, and it keeps the speed and zoom the page before it was to take
  over, so two moves in a row lose nothing (item 1).
- **A second move while the first waits for its snapshot** is not dropped: the move goes to the
  spot the learner asked for last (item 7).
- **Progress is saved at the snapshot's playhead** before the move, for a Lesson the learner has
  played or moved, so a crash during the move loses nothing.
- **Nothing is sent to the page that is going.** The move ends its `load`: a sidecar sound that
  becomes ready meanwhile goes to the new page after its `load` (ADR 0034), and late events of the
  old page are not about the Lesson. The adapter also stops forwarding them.

## The cost in activation (#12 D3, D9)

The new page has not had the learner's click. It really asks to play a Lesson that played
(condition a), and plays on if VS Code lets it; VS Code 1.146 refuses autoplay on a page without a
click (#12 D3, measured by #16 and #23), so in practice **moving a playing Lesson lands it paused at
its position**, and the core tells the learner once to press play in the player (the D3 message).
One click in the new page unlocks keyboard play again, as for any new page. Seam 1 covers both
outcomes. Moving a paused Lesson costs nothing visible until the learner next plays it from the keys.
The spec's "keeping paused state" therefore holds for a paused Lesson; a playing one keeps its time,
speed and zoom and needs that one click. The alternative, moving a view between containers with
VS Code's own drag, keeps the page but has no API, and an editor tab cannot become a view at all.

**Measured, for #50 and #51:** every move in the smoke test (bottom panel → secondary sidebar →
editor group → bottom panel again, on VS Code 1.146, Windows and Ubuntu) is followed by a new
`ready`: a new page. The API has no way to hand a page from a webview panel to a webview view or
back, and a view hidden by its `when` clause gets a new page when it shows again. Moving an editor
tab into an auxiliary window (#51) was not measured here.

## In VS Code

- **Two webview views** in their own view containers, `followalong-video-panel` (in `panel`) and
  `followalong-video-sidebar` (in `secondarySidebar`), each holding a `Video` view. Their `when`
  clauses read the context key `followalong.videoSpot`, so only the spot the video is in shows a
  container; the editor split is the webview panel of before (`followalong.player`). The views
  retain their page while hidden, so the Lesson plays on while the panel or sidebar is closed.
- **Opening a view spot** first sets the context key (awaited, so the view's `when` clause holds),
  then runs the view's own `<view>.focus` command, which also brings back a view the learner hid
  from the container's menu (item 3). It focuses the view; the adapter hands focus back at once
  (ADR 0009), as `preserveFocus` does for the panel. If VS Code cannot open the view, or no view
  comes within 5 s, the adapter reports the player closed and, for the wait, tells the learner
  once, so the core never waits for a page that will not come. The view's description is the
  Lesson's title. The learner resizes every spot with VS Code's own sashes (story 56).
- **A view's page is started only once VS Code shows that view.** VS Code disposes a view its
  `when` clause hides and resolves a new one when the spot is used again (measured with a trace in
  CI run 43897862321), so the page goes into the view VS Code resolves, never into one it has let
  go.
- **The focus return can hide the bottom panel.** Measured (CI run 43898701222): right after the
  player moved there from an editor group, handing focus back to the code editor hid the panel
  25 ms later. The adapter then shows the view again with `WebviewView.show(true)`, which keeps
  the focus in the code, and watches for such a hide for 1 s after the move. CI run 43899415033
  passes the smoke step that moves back into the bottom panel on Ubuntu and Windows. **Not when
  focus went back to a terminal** (item 4): focus return wins (#12 D12), so the terminal the
  learner types in stays in front, and the video waits behind it.
- **Closing.** Closing the player tab, or a view VS Code disposes, is a close as before; the page
  dropped for a move is not.
- **Resources** (D4): in a view spot the player is in no editor group, so a Resource opens
  `ViewColumn.Beside` the code, which ADR 0012's placement already does when the player has no
  column; Simple Browser gets the same column (ADR 0048).

## Consequences

- In the bottom panel the video is a tab beside the terminal: the panel shows one of them at a
  time. A Focus return to a terminal (ADR 0009) shows the terminal tab, which hides the video until
  the learner drags the video view beside it. FollowAlong does not fight this (#12 D12: focus
  return wins); it is recorded on #12 as a known limitation, pending Windows QA (#64).
- `ZoomView` and its check `isZoomView` moved into the protocol module, which both sides import;
  `src/player/zoom.ts` re-exports them.
