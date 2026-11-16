# The Progress line in the Course picker

#36 shows where the learner stands in each Course before they open it (spec #12, story 8). It builds
on the Progress store (ADR 0010, 0030, 0061), the Lesson tree's totals (ADR 0043) and the live
Course picker (ADR 0058). These are the choices the spec leaves open.

- **A second line, not part of the description.** A picker item gets an optional `detail` (VS Code's
  second line under the label). The description stays the category path and the `(open)` / `missing`
  tags, so typing still matches categories (story 7) and never matches `27/140`.
- **What "with Progress" means.** The Course's Progress has at least one Lesson of the Course that
  is in progress or done. A Course nobody played, a Course whose Progress was reset (ADR 0061: only
  entries without a status remain) and a Course with no Lessons have no Progress line.
- **One counting rule.** `27/140 · 19%` is `summaryOf` / `totalsOf` in `lesson-tree.ts`, the same
  function the tree uses (percent rounded down, 100 only when every Lesson is done). The `last:`
  title is the Lesson's title as the Course model gives it (ADR 0014). A `last` that is empty (reset)
  or names a Lesson the Course no longer has leaves out ` · last: …`.
- **Read-only, and the two locations.** Progress is read with the Progress store's `read` (the
  newest entry per Lesson across `.followalong` and the fallback storage, spec D5 as amended). Nothing
  is written. A file that is damaged, unreadable or from a newer FollowAlong gives no Progress line
  and stays as it is.
- **Background, never before the first show.** The picker opens at once from the cache with no
  lines. The lines of the cached Courses are read in the background straight away, and those of
  Courses a scan adds as soon as it is done, in batches of 8, and the picker is updated as each
  batch is in (the way the scan updates it, ADR 0058). Refresh reads them again. The Progress file
  is read first and the Course's folder only for a Course that has Progress, so most of a library
  costs one failed read.
- **Busy until the lines are in.** The picker's busy indicator stays on while Progress lines (or the
  Recent check) are being read, so "complete" still means complete. The learner can pick a Course at
  any time while it is busy.
- **Refresh keeps the old lines until the new ones are in**, so the list does not flicker; a Course
  whose Progress cannot be read on the re-read loses its line.
- **`last` names the Lesson played last, even one reset since** (Reset Section leaves `last`, ADR
  0061): it is still where the Course reopens. Only an empty or unknown `last` leaves out `last:`.
