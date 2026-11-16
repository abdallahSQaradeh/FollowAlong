# Course Resources hang on a Course node at the top of the tree, and attach through the Lesson path

Spec #12 (stories 91 and 93) wants material for the whole Course, such as a cheat sheet, always at
hand: a "+" on the Course in the tree, and Course Resources at the top, above the Sections (#56).
ADR 0040 already keeps `course` records in the one Resource store, and detaches, relinks, merges
and dims them. These are the choices the spec leaves open.

- **A Course node in the view model.** The tree had no node for the Course itself, so the "+" had
  nowhere to sit. `LessonTreeModel` gets `course`, a `CourseNode` (`kind: 'course'`, the Course
  folder's name, its Resources). The adapter draws it as the first root, before the Lessons and
  Sections, so the Course Resources are at the top and `nodes` is exactly what it was. The
  node has an id, `<course>`, that cannot be a Lesson (a file name with an extension) or a Section
  (ends in `/`); the "+" passes it to `followalong.attachResource`, and the adapter routes it to
  `attachCourseResource`. It is expanded when it holds Resources, like a Lesson.
- **One attach path.** `attachTo` in `follow-along.ts` takes a target, a Lesson or the Course, and is
  the only place that asks for the file, attaches it and says what happened. The Course and its
  store are fixed before the dialog opens (ADR 0024), so a Course opened meanwhile never receives the
  file; the learner is told where it went (“attached “x” to the Course in “First”, which is no
  longer open.”). The store gains `attachToCourse(path)`, the same change as `attach`, so ordering,
  re-read, refusal and the fallback copy all apply. Detach, Relink, the missing-file dimming and
  `openResource` already look a Resource up by id across the Course and Lessons: they need no new
  code, and a Course Resource opens exactly as a Lesson Resource does (D4: never in the player's
  group).
- **Files only here.** The criteria say “a file or URL”. URL Resources are #55. The Course "+"
  goes through `attachTo`, the path #55 extends, so no URL code is here and #55 changes both "+"
  buttons at once.
- **A Course with no Lessons has no Course node** and nothing to attach to: it shows only its
  message, as before. `attachCourseResource` logs and does nothing there.

## Consequences

- `resources.json` is unchanged: the `course` array was already written and read (ADR 0005).
- Progress in the tree (#28) builds the same view model; its merge is a matter of keeping `course`.
