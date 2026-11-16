# Collapsing and restoring the video: a move to no spot, in the same spot

`Ctrl+'` `V` (and _FollowAlong: Toggle video_) collapses the video where it is and brings it back on
the next press (spec #12, story 57, D10; ticket #52). The spec says what the key does, not what
collapsing is in each spot. Source: #52, ADR 0049, the orchestrator's binding notes on #52.

- **Collapse is a move to no spot.** The core asks the page for a snapshot as a move does (the same
  1 s wait on the Clock port, the same fallback to what the core knows), saves Progress at the
  snapshot's playhead, and keeps what a restore needs: position, play or pause, speed, zoom and
  whether the Lesson had ended. Then `PlayerPort.collapse()` drops the page. It is not a close:
  `onDidClose` stays quiet, the Lesson stays loaded, and the spot is kept.
- **Restore is a move to the spot the video was in.** The next press shows the player there,
  which makes a new page (ADR 0049); it loads the Lesson at the carried position, `autoplay` as it
  played, then `setRate` and `restore {zoom}`. Everything of ADR 0049 holds: a move never writes
  `followalong.videoLocation`; and the new page has not had the learner's click (#12 D3), so a Lesson
  that played may land paused, with the D3 message. A paused Lesson restores paused.
- **What collapse means in each spot.**
  - _Editor group beside the code:_ the player's tab closes. The group VS Code leaves is VS Code's.
  - _Bottom panel:_ the video view hides (the context key `followalong.videoSpot` is cleared) and
    the panel closes, unless the learner has a terminal, in which case the panel stays with the
    terminal in front (finding 1 below).
  - _Secondary sidebar:_ the view hides and the secondary sidebar closes.
- **Playback while collapsed.** There is no page, so the Lesson does not play on. A playback command
  (play/pause, steps, speed) tells the learner "the video is collapsed. Press Ctrl+' V to bring it
  back." and sends nothing. Opening a Lesson (next, previous, a picker) or _Move video to…_ shows
  the video again, in the spot it was in, or in the spot the learner picked. A second press while
  a snapshot is awaited undoes the first: the last thing asked for wins.
- **The chord letter is `V`** (D10). No other FollowAlong binding uses it; `D` is Mark done, `A`
  is Attach Resource today and reserved for auto-pause by the spec (#61), and #48 adds `Z`, `=`,
  `-`, `0`.

## The six findings routed from the #49 review

1. **A panel with a terminal is not closed.** Leaving the bottom panel closes it only when
   `window.terminals` is empty, which is the case that spawned a shell (ADR 0049). The secondary
   sidebar is always closed. The smoke test moves the video out of a panel that holds a terminal
   and checks the panel is still open.
2. **Moves are ordered.** The adapter sets the spot at once and queues what VS Code must do (close,
   set the context key, open the view) in the order asked, so two quick moves end at the spot
   asked for last.
3. **Nothing closes on dispose.** Deactivating or reloading drops the page but leaves the learner's
   panel and sidebar as they are, and no promise is left to reject at shutdown.
4. **A close VS Code refuses does not stop the move.** It is logged, then the next step runs, so the
   view's 5 s wait always starts.
5. **A starting page's carried `ended` is forgotten when another Lesson loads or none is.** Speed and
   zoom still carry (zoom belongs to the page, ADR 0037); only "the Lesson before ended" goes.
   Seam 1 covers it.
6. **A second open of the same spot disposes the first wait.** Seam 1 cannot see it (adapter); it is
   reviewed.
