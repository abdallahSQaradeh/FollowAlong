# The zoom keys send the `zoom` message

Spec #12 (story 62) puts zoom on the `Ctrl+'` chord. These are the choices the spec left open.
Source: #48, the routed note on it from #47, ADRs 0037, 0087 and 0088.

- **Four keys, four commands.** `Z` is `FollowAlong: Zoom area`, `=` is `Zoom in`, `-` is `Zoom out`
  and `0` is `Zoom reset` (`followalong.zoomArea`, `zoomIn`, `zoomOut`, `zoomReset`). Each has a
  Command Palette entry and the chord form `ctrl+' <key>` (`cmd+'` on macOS, best effort), when
  `editorTextFocus || terminalFocus`, like the other chords. The letters clash with none: `D` is
  Mark done, `A` is taken, and `V` is for #52.
- **The `zoom` message grows, no new message.** `ZoomAction` is `reset | in | out | areaMode`
  (`zoomActions` and `isZoomAction` in the protocol), and the parser accepts exactly those. The
  core only forwards the action (`core.zoom(action)`); the player knows what it shows and reports
  `zoomChanged`. The status bar item's reset uses the same path.
- **The keys change the view through `ZoomControls`** (`run(action)`),
  which call `show()` with `zoomBy` from `src/player/zoom.ts`. They are the toolbar's own steps:
  1.25× a press, from 1× up to 8×, around the middle of the picture, so a key and the ＋ / −
  buttons agree. The press kind of a drag is not touched: area mode already forces a box.
- **`Z` toggles area mode**, as the toolbar's area button does. A second press leaves it, so a
  learner who pressed it by mistake is not stuck without the mouse. Area mode still ends by itself
  after the next drag, and with a reset.
- **A drag under way is not interrupted.** `in`, `out` and `areaMode` do nothing while a press is
  down, as the wheel does (ADR 0088): the box is drawn over, and the pan moves from, the view as it
  was. `reset` still ends the drag, as ADR 0037 says. The player's actions run through one
  `ZoomControls.run(action)`, which the toolbar's buttons use too.
- **No Focus return.** A key press never took focus from the editor or terminal, so the zoom
  commands hand nothing back (unlike a status bar click, ADR 0009). With no Lesson loaded a zoom
  key says so, as the other playback keys do, and with a player still starting it is dropped.
