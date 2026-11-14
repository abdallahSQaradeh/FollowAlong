# PROTOTYPE: where the video sits (throwaway)

Answers the wayfinder ticket **Where the video sits** (abdallahSQaradeh/FollowAlong#4). Never merged into main.

Run: `code --extensionDevelopmentPath="D:\Projects\FollowAlong\prototypes\video-placement" D:\Projects\FollowAlong`

- Five spots for the Lesson video (A editor split, B bottom panel, C secondary sidebar, D mini strip, E floating window), switched from the yellow status bar arrows or `Ctrl+'` `[` / `]`.
- Player (`player.js`, `player.css`, inlined into each webview): drag a box to zoom to an area, Shift+drag for a new area, drag to pan, wheel zoom, double-click reset, `Ctrl+'` `Z` / `=` / `-` / `0`.
- `node test-player.js` runs the zoom-logic checks against a fake DOM.

Verdict: all five spots in v1, A by default. See the resolution comment on the ticket.
