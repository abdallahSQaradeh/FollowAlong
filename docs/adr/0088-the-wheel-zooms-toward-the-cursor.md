# The wheel zooms toward the cursor, in steps of a notch

Spec #12 (story 60) asks for the wheel to zoom in and out toward the cursor. These are the choices
the spec left open. Source: #47, the routed note on it from the #46 consult, and ADR 0037.

- **A step is the toolbar's step.** The wheel turning away from the learner zooms in, and towards
  zooms out, by 1.25× (`zoomStep`) for each 100 px of `deltaY`: one notch of a mouse in Chromium.
  The level stops at 1× and 8×, as ADR 0037 says, and a level that reads `1×` is the whole picture.
- **The point under the cursor stays under it** (`zoomAt` in `src/player/zoom.ts`), as far as the
  picture's edges allow: zoomed out to the whole picture, zoomed in against an edge, the view
  never leaves the picture. It works from 1× as well as while zoomed.
- **Turns add up to steps, so a trackpad zooms too.** A trackpad sends many small `deltaY`. If
  each applied its own fraction of a step, the first would read `1.0×`, which is the whole
  picture, and the learner could never leave 1× with one. So the turn is counted: each 100 px is a
  step, and the rest waits for the next turn of the same gesture. The rest is dropped when the
  direction reverses and when a turn comes more than 250 ms after the one before (the gesture is
  over), so half a notch from a minute ago does not tip the next one.
- **Only over the picture.** The wheel is heard on the click overlay, so a turn over the toolbar,
  the Next overlay, or (at 1×) the native control bar does what it did before.
  The wheel's default is cancelled over the picture, so the page does not scroll and a Ctrl+wheel
  does not zoom the webview itself.
- **A drag under way ignores the wheel**: its box, or the view it pans from, would be stale.
- **A turn is not an interaction.** It takes no focus from the editor (unlike a click, a press on
  the toolbar or a key), so there is no Focus return to do and it reports no `userInteracted`.
  It does not play or pause the Lesson.
- **Pinch** on a trackpad arrives as a Ctrl+wheel with small deltas. It goes through the same
  counting, so it zooms, coarsely. A smoother pinch is not part of this ticket.

## Considered options

- **Zoom by `1.25 ** (-deltaY / 100)`, a continuous factor.** Rejected: it cannot leave 1× with
  small deltas (see above), and it would make the wheel's level depend on how a device chops a
  turn.
- **A step for every wheel event whatever its `deltaY`.** Rejected: a trackpad swipe sends dozens
  of events, and would zoom from 1× to 8× in one swipe.
