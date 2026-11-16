# A play sent from a command is refused until the learner has clicked in the player

VS Code 1.146 refuses unmuted autoplay in a webview (spec #12, D3), and the smoke test of #16
measured that the same holds for `play` sent from an extension command, which is what the
`Ctrl+Alt+Space` and `Ctrl+' Space` keybindings run: the player's `play()` rejects with
`NotAllowedError` and posts `paused {byUser: false}` on Windows and Ubuntu alike (CI run
43779753589). So no keyboard command can start a Lesson until the learner has clicked play in the
player once. Stories that say a Lesson plays right away (33, 70) hold only after that click.

The core does not hide this. When the player answers a `play` the core sent with
`paused {byUser: false}`, it shows the same "Press play in the player" message as for a refused
autoplay. The first refused keypress is told even after a refused autoplay was (the learner looks
for feedback at the keypress, and the toast from the load may be gone); further refused keypresses
say nothing, so repeated keypresses do not stack messages. A `played` or a new `load`
ends that run. The protocol does not change. Whether one real click lets later commands start playback
(sticky user activation) cannot be produced in CI; it is a Manual QA item.

## Considered options

- **Say nothing.** Rejected: a dead key with no explanation.
- **Muted autoplay, then unmute.** Rejected for #16: it changes the sound behaviour of the whole
  player, which needs its own decision.
