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

One step of the queue of spot changes (`placing`, review of #49, item 2), so it never meets the
close of the spot before it, and the last spot asked wins:

1. `workbench.action.newGroupAbove`: a new, empty, active group above the learner's. It is waited
   for with the 5 s safety wait the views have; a refusal or a hang is the same as a view that
   never opens: logged, the learner told once, the player counted as closed.
2. The player's panel opens in the active group (`ViewColumn.Active`, `preserveFocus`).
3. Where the learner has exactly the code and the strip, `vscode.setEditorLayout` sizes the strip
   to 26 % of the editor area (the prototype's 0.26 / 0.74), the learner resizes it with the
   sash (story 56). With more groups the layout is **not** touched: it is the learner's.
4. `workbench.action.focusBelowGroup` makes the group the code is in the active group again (the
   strip's group is active after step 1, which would send the next `Beside` there), and the usual
   focus return hands keyboard focus back (ADR 0009), to the terminal if that is where the
   learner was (#12 D12). The strip is not in a panel, so there is no `keepShown`.

A second move while the group is being made is not lost: the player is awaited in the spot asked
last, and a group made for a spot the learner has left again is closed (`closeGroup`, the group is
the active one and nothing else has run, because the steps are queued).

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

`PlayerPanel.viewColumn` is the strip's group, so a Resource never opens in it (ADR 0012). With the
strip in column 1 and the code in column 2, the placement's "a new group at the end" is a group
to the right of the code, under the strip: the strip keeps the full width.

## Consequences

- The strip's height is a start, not a setting: the learner drags the sash. The 26 % comes from
  the prototype, where it showed the instructor's code at a size that could be read once zoomed.
- A learner with several editor groups gets the strip above the group they are in, at the size VS
  Code gives a new group (half). Resizing is theirs.
- The smoke test reads the real layout (`test/smoke/suite/index.ts`, _theStripIsAboveTheCode_).
