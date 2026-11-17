# A plain drag pans a zoomed picture, and Shift+drag draws a new area

Spec #12 (story 60) asks for a drag that pans while zoomed, and Shift+drag for a new area. ADR 0037
left every drag drawing a box until this ticket. These are the choices the spec left open. Source:
#47, the routed note on it from the #46 consult, and ADR 0037.

- **What a drag does is fixed when the press begins, and kept until it ends.** At 1× a plain drag
  draws a box (it has nothing to pan). While zoomed a plain drag pans, and a drag with Shift held
  at the press draws a box. Area mode (the toolbar's area button) also draws a box, at any zoom, as
  ADR 0037 says. Letting go of Shift mid-drag, or pressing it, changes nothing: a gesture that
  turned into another halfway would jump the picture under the learner's hand. The press is the
  only moment `shiftKey` is read.
- **The picture follows the pointer** (a hand grabbing it), and the point of the picture under the
  pointer when the press began stays under it, as far as the picture's edges allow. The view is
  clamped to the picture (`panBy` in `src/player/zoom.ts`), so a pan never shows black. A pan never
  changes the level, so it reports nothing to the extension (`zoomChanged` is about the level).
- **The pan is kept once, where it ends** (a release, a cancel, a lost capture, a reset). While the
  pointer moves only the transform changes; writing the webview state on every move would post a
  message to VS Code for each one. A reloaded page therefore shows where the last pan ended.
- **A drag is not a click, and hands focus back once.** A pan uses the drag mechanism of ADR 0037:
  it is a drag after 6 px, the `click` after it does not play or pause, and it is one gesture for
  Focus return (ADR 0009), so focus returns when it ends and not during it. The click and
  double-click rules (a single click waits 300 ms only while zoomed, a double-click resets) are
  unchanged.
- **A reset, or a view from another spot, while a pan is under way ends it**, as it ends a box
  (ADR 0037): the release that follows neither moves the picture nor plays.
- **The pointer says which**: an open hand over a zoomed picture (`grab`), closed during a pan
  (`grabbing`), and a crosshair in area mode, which wins over the hand. Shift is not tracked
  between presses, so the cursor does not change when the learner holds it; the toolbar's area
  button is how a learner without Shift draws a box.
- **The zoom keys are not here.** `Ctrl+'` `Z`, `=`, `-` and `0` belong to #48.

## Considered options

- **Let Shift change a drag already under way.** Rejected: see above, the picture would jump.
- **Pan relative to the point where the drag passed 6 px**, not to the press. Rejected: the
  picture under the pointer would not stay under it, by the 6 px of the threshold.
- **Write the webview state on every pan move.** Rejected: one message to VS Code per pointer move
  for a state only the last of which matters.
