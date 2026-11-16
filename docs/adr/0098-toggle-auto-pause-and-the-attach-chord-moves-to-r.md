# Toggle Auto-pause switches off and the last mode, and Attach Resource moves to `Ctrl+'` `R`

Spec #12 (story 105) and ticket #61 add `FollowAlong: Toggle Auto-pause` on `Ctrl+'` `A`. ADR 0023
had given `A` to Attach Resource (#57). These are the choices the spec leaves open. Sources: #61 and
its routed notes, D10 and D15 on #12, ADR 0023, ADR 0052, ADR 0089, ADR 0090.

- **The letters (D10).** `Ctrl+'` `A` (`Cmd+'` `A` on macOS) is Toggle Auto-pause. Attach Resource
  moves to `Ctrl+'` `R`, as the orchestrator ruled on #12. Taken: `Space`, `,`, `.`, `←`, `→`, `↑`,
  `↓`, `N`, `P`, `C`, `L`, `D`, `V`, `Z`, `=`, `-`, `0`, `A`, `R`. The command ids do not change, so
  a learner's own keybinding for either command still works.
- **It writes only `followalong.autoPause`** (D15, ADRs 0089 and 0090). The quiet period,
  `followalong.autoPauseResumeAfter`, is the learner's own and is never touched. The Loaded Lesson
  reacts to the change of the setting as it does to an edit in the Settings editor, so turning
  auto-pause off during an auto-pause cancels the quiet period at once, with no extra code.
- **It toggles between `off` and the last mode that was on.** Off turns on as that mode; on turns
  off. With no mode ever on, it turns on `pause`, the gentler of the two (`pauseAndResume` acts on
  its own). Any other value of the setting (unset, a typo) reads as `off`, as everywhere (ADR 0052).
- **The last mode is remembered in the global storage** (`lastAutoPauseMode`), so it survives a
  restart of VS Code. It is kept by a watcher in the core that reads the setting when the window
  opens and on every change, so a mode the learner chose in the Settings editor counts too, not
  only one the toggle turned off. A failed write is logged, never thrown at the learner.
- **The setting is global, not per Lesson.** The ticket says "per Lesson" in the sense that it can be
  switched while a Lesson plays; there is no per-Lesson setting, and `followalong.autoPause` stays
  the one user setting #59 shipped.
- **It works with no Lesson loaded**, because the setting does. The status bar marker is shown only
  while a Lesson is loaded, so then, and only then, an information message says what the key did
  ("auto-pause is on (pause)." / "auto-pause is off."). With a Lesson loaded the marker is the
  answer and no message is shown.

## Consequences

- ADR 0023's letter `A` is superseded by `R`; its other choices stand.
- The smoke test checks both chords in the real VS Code. The toggle's behaviour is Seam 1.
