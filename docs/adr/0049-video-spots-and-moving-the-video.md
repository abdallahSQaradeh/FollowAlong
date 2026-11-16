# Video spots, and moving the video with a snapshot of the player page

#49 lets the video sit in three spots (spec #12, stories 52–56 and 65): an editor group beside the
code (`editorSplit`, the default), the bottom panel (`bottomPanel`) or the secondary sidebar
(`secondarySidebar`). `followalong.videoLocation` names the spot a new player opens in, and
_Move video to…_ moves an open player live, keeping its time, speed, play or pause, and zoom. These
are the choices the spec left open. Source: #49, the routed note from #46 on it, #12 D3/D4/D9, and
the orchestrator's answers to the #49 consult (Q1–Q4).

## Where the video opens

- **The setting names where a new player opens** (Q1, Q2). The core reads `videoLocation` when it
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
  `restore {zoom}` when it was zoomed. The page shows that view, keeps it in its own webview state
  and reports `zoomChanged`, as for a zoom the learner made.
- **A page that does not answer** within 1 s (Clock port) is moved with what the core knows: the
  last reported playhead, play state and speed; the zoom then starts at the whole picture. A page
  still starting is moved at once, the Lesson starting where it was going to.
- **Progress is saved at the snapshot's playhead** before the move, for a Lesson the learner has
  played or moved, so a crash during the move loses nothing.
- **Nothing is sent to the page that is going.** The move ends its `load`: a sidecar sound that
  becomes ready meanwhile goes to the new page after its `load` (ADR 0034), and late events of the
  old page are not about the Lesson. The adapter also stops forwarding them.

## The cost in activation (#12 D3, D9)

The new page has not had the learner's click, so VS Code refuses its autoplay. **Moving a playing
Lesson lands it paused at its position**, and the core tells the learner once to press play in the
player (the D3 message); one click in the new page unlocks keyboard play again, as for any new
page. Moving a paused Lesson costs nothing visible until the learner next plays it from the keys.
The spec's "keeping paused state" therefore holds for a paused Lesson; a playing one keeps its time,
speed and zoom and needs that one click. The alternative, moving a view between containers with
VS Code's own drag, keeps the page but has no API, and an editor tab cannot become a view at all.

## In VS Code

- **Two webview views** in their own view containers, `followalong-video-panel` (in `panel`) and
  `followalong-video-sidebar` (in `secondarySidebar`), each holding a `Video` view. Their `when`
  clauses read the context key `followalong.videoSpot`, so only the spot the video is in shows a
  container; the editor split is the webview panel of before (`followalong.player`). The views
  retain their page while hidden, so the Lesson plays on while the panel or sidebar is closed.
- **Opening a view spot** runs `workbench.view.extension.<container>`, which focuses the view; the
  adapter hands focus back to the code at once (ADR 0009). The view's description is the Lesson's
  title. The learner resizes every spot with VS Code's own sashes (story 56).
- **Closing.** Closing the player tab, or a view VS Code disposes, is a close as before; the page
  dropped for a move is not.
- **Resources** (D4): in a view spot the player is in no editor group, so a Resource opens
  `ViewColumn.Beside` the code, which ADR 0012's placement already does when the player has no
  column; Simple Browser gets the same column (ADR 0048).

## Consequences

- In the bottom panel the video is a tab beside the terminal: the panel shows one of them at a
  time. A Focus return to a terminal (ADR 0009) shows the terminal tab, which hides the video until
  the learner drags the video view beside it. Manual QA (#64), and a note for the orchestrator.
- `ZoomView` and its check `isZoomView` moved into the protocol module, which both sides import;
  `src/player/zoom.ts` re-exports them.
