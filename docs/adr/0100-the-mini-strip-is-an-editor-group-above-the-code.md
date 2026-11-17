# The mini strip is an editor group above the code

#50 adds a fourth video spot (spec #12, story 53; decision #4): a short editor group above the code,
`miniStrip`. It is a valid `followalong.videoLocation` value and a _Move video to…_ target, and it
keeps time, speed, play or pause and zoom like the other spots (ADR 0049). These are the choices
the spec and the prototype left open. Source: #50, ADRs 0049, 0092 and 0009, #12 D3, D4, D12, the
placement prototype (`prototypes/video-placement`, commit 6acecc4, spot D) and the orchestrator's
binding notes on #50.

## What it is

- **The same webview panel as `editorSplit`, in another group.** The strip is a
  `WebviewPanel` of the same view type, so Resources, the focus return and `retainContextWhenHidden`
  work as they do beside the code. Only the group differs: above the code instead of to its side.
  Nothing in the core knows the difference. `miniStrip` joins `VideoSpot`, with the label _Mini strip
  above the code_, last in the picker.
- **The prototype's layout, not its code.** The prototype set the layout with
  `vscode.setEditorLayout` and then opened the player in column 1 beside the code's own tab, which
  puts a video tab in the code's group. Here the strip is made with `workbench.action.newGroupAbove`
  on the group the learner types in, so the code stays where it is and the strip is a group of its
  own, holding nothing but the video.

## How the adapter makes it

**Every spot opens through the queue of spot changes** (`placing`, review of #49, item 2), the
editor group beside the code now too: `show()` records the spot asked for (`awaitedSpot`) and queues
its opening behind the close of the spot before it, so the spot asked for last is the one that
opens. A group is made or found only once the spot before has gone, and each step looks again
whether the player is still awaited in its spot (the learner may have asked for another one,
collapsed the video, or VS Code may be closing).

The strip's own steps:

1. **Wait for the group of the spot before to close**, for at most 500 ms. Closing a tab leaves its
   group behind for a moment, empty or still listing the page just dropped; a new group made beside
   it would put the strip in the wrong place. (Smoke test, CI: the first version counted that group
   and left the strip at VS Code's half height.) A learner who keeps empty groups
   (`workbench.editor.closeEmptyGroups` off) waits that moment each time.
2. `workbench.action.newGroupAbove`: a new, empty, active group above the learner's. It has the 5 s
   safety wait the views have; a refusal or a hang while the strip is still awaited is the same as
   a view that never opens: logged, the learner told once, the player counted as closed. After the
   learner has asked for another spot, a late or failed group is only noted.
3. The player's panel opens in the active group (`ViewColumn.Active`, `preserveFocus`).
4. Where the learner had exactly one group with something of theirs in it before (counted before step 2, not counting a group that holds only the player), `vscode.setEditorLayout`
   sizes the strip to 26 % of the editor area (the prototype's 0.26 / 0.74); the learner resizes it
   with the sash (story 56). With more groups the layout is **not** touched: it is the learner's.
5. `workbench.action.focusBelowGroup` makes the group the code is in the active group again (the
   strip's group is active after step 2, which would send the next `Beside` there), and the usual
   focus return hands keyboard focus back (ADR 0009), to the terminal if that is where the learner
   was (#12 D12). The strip is not in a panel, so there is no `keepShown`. Steps 4 and 5 are skipped
   if the player has moved on or been collapsed since step 3.

A group made for a spot the learner has left again while it was made is closed
(`workbench.action.closeGroup`) **only if the active group is empty** (it is the one just made;
the learner may have clicked into the code meanwhile, and then nothing is closed), and never while
VS Code is going away (nothing closes on dispose, ADR 0092 finding 3).

## Leaving and collapsing

- **Leaving the strip closes its tab, and VS Code closes the empty group** (the
  `workbench.editor.closeEmptyGroups` default, as for `editorSplit`: "the group VS Code leaves is
  VS Code's", ADR 0092). A learner who turned that setting off keeps an empty group.
- **Collapse** (`Ctrl+'` `V`, ADR 0092) is a move to no spot: the strip's tab closes and the code has
  the whole editor area again. **Restore** shows the player in the spot it was in, so it makes the
  strip again above whichever group the learner is in then, with the same size rule. A collapsed
  strip and a collapsed split are the same thing in this respect; no new state is kept.
- **A moved spot holds** (ADR 0049, Q1): moving to the strip never writes `videoLocation`, a new
  player opens at the setting, and a changed setting applies to the next new player.

## What a move costs here

Every move makes a new page (ADR 0049, #12 D3): a playing Lesson that moves into or out of the strip
may land paused, with the one message. Nothing about the strip changes that.

## Zoom in the strip

The zoom view is stored as fractions of the player (ADR 0037), so a page of any shape takes the
view of another and shows the same area. In a strip about five times as wide as it is high the
picture is letterboxed; the page is what zooms, and a box dragged over the picture is a box on the
page, so a box about as high as the strip zooms to 2× or more, as in any spot. Seam 2
(`test/player/mini-strip.spec.ts`) covers the drag, the toolbar, the wheel, the click and a restored
zoom in a 1000 × 200 page.

## Resources and the strip

`PlayerPanel.viewColumn` is the strip's group, so a Resource never opens in it (ADR 0012). Where the
learner had only the code, the strip is column 1 and the code column 2, and the placement's "a new
group at the end" is a group to the right of the code, under the strip: the strip keeps the full
width. With more groups the strip sits above the group the learner was in, and the Resource goes
where the placement's rules put it.

## After the merge with the floating window (#51)

The floating window (ADR 0102) now opens as one more case of the same queue (`open(spot)`): its
tab is made when its turn comes, and the queue waits for its move into the new window, as the spot
changes after it must. That exposed a race the earlier timing hid (CI, merged head 67cc415): a
collapse that comes while `moveEditorToNewWindow` is running disposed the tab mid-move and left an
empty floating window open. A floating tab dropped during that command is now disposed once the
command has finished, in its new window, which VS Code then closes as it does for any closed tab.

## Known limits

- A group `newGroupAbove` makes after its 5 s wait ran out (VS Code very slow) is left as it is, an
  empty group: the player was counted closed, or the learner had asked for another spot, and
  closing a group that may by then be the learner's is worse. It is noted in the log.
- A quick move to a view and back to the strip may still ask VS Code to open the view first (a
  queued `<view>.focus` runs although the learner has moved on, as in #49). It shows the video's
  container, not a page.

## Consequences

- The strip's height is a start, not a setting: the learner drags the sash. The 26 % comes from
  the prototype, where it showed the instructor's code at a size that could be read once zoomed.
- A learner with several editor groups gets the strip above the group they are in, at the size VS
  Code gives a new group (half). Resizing is theirs.
- The smoke test reads the real layout (`test/smoke/suite/index.ts`, _theStripIsAboveTheCode_).
