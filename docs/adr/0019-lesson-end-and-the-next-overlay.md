# The end of a Lesson: the player stops, the core offers "Next", the learner's click moves on

Spec #12 (story 50) wants playback to stop at the end of a Lesson and show a "Next: <title>"
overlay, without auto-advancing, and lists `showNext {title}` and `nextClicked` in the protocol. These
are the choices the spec leaves open.

- **The core decides, the player draws.** On `ended` for the loaded Lesson the core looks for the
  Lesson after it in Course order (ADR 0017, the same lookup as `nextLesson`). If there is one it
  sends `showNext {title}` with that Lesson's title, as the tree shows it (a Title list counts).
  There is no timer and no other path that loads a Lesson at the end: nothing moves on until the
  learner clicks (spec, Out of Scope: auto-advance).
- **The last Lesson shows nothing.** No next Lesson, no message, no overlay: the player stays on
  the last frame. The same holds for a Course opened with no Lessons after another one.
- **A click moves on through the same path as `Ctrl+'` `N`.** `nextClicked {lessonId}` makes the
  core call the step `nextLesson()` uses (`moveToLesson(1)`), so the next Lesson loads exactly as
  one picked in the Lesson picker or reached by the key. The `lessonId` follows ADR 0003: an event
  about a Lesson carries its id, and the core ignores one for a Lesson that is no longer the loaded
  one, so a click that arrives after the learner moved on cannot skip a second Lesson.
- **The overlay is one button over the picture.** It covers the picture and stops above Chromium's
  native control bar, as the click overlay of ADR 0009 does, and is stacked above it, so a click on
  it is never a click on the picture (which would play the ended Lesson again). It is a `<button>`,
  so it can also be reached and pressed from the keyboard. The title is set as text, never as
  markup: a Lesson title comes from a file name or a `.txt` file.
- **When it goes away.** The player hides it when a Lesson loads, when the Lesson plays again and
  when the playhead is moved back into it (a step, a seek bar drag). It shows `showNext` only while
  the media element is still at its end: the extension answers `ended` asynchronously, and a
  learner who pressed play in between must not find the overlay over a playing picture.
- **Focus return.** A click on the button is a player interaction. The mechanism of ADR 0009
  (#23) reports the end of an interaction from a `pointerup` on the page, which the button's click
  does not stop, so it hands focus back without a line of its own here. This was checked on a
  throwaway merge with #23's branch: a click on the button posts `userInteracted`, then
  `nextClicked`, and no `played`. On this branch alone nothing returns focus, as nothing else in
  the player does.
- **Autoplay.** The click is a user gesture, so the Lesson it loads is not refused autoplay (ADR 0008).

## Considered options

- **Let the player show the overlay by itself on `ended`.** Rejected: the player does not know the
  Course, so it would have to be told the title in advance and told when there is no next Lesson.
  Spec #12 puts the Course's order with the extension.
- **A timed auto-advance with a cancel button.** Rejected by the spec: the learner may be typing,
  and a timer that carries them into the next Lesson is what story 50 rules out.
- **A message at the last Lesson ("This was the last Lesson").** Not asked for; the ticket says the
  last Lesson shows no overlay.

## Consequences

- `PlayerCommand` gains `showNext {title}`, and `PlayerEvent` gains `nextClicked {lessonId}`; both
  parsers know them (ADR 0003).
- The player page has a new element and the player CSS a new rule, so #23's click overlay and this
  one are stacked by order and `z-index`; later overlays (sound progress, zoom toolbar) must choose
  their place in that stack.
