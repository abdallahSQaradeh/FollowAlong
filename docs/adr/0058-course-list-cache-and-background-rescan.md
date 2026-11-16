# The Course list cache, the background rescan and Refresh

#37 makes the Course picker open at once, however large the library (spec #12, stories 12 and 13).
Until now the picker scanned the Courses roots before it showed (ADR 0022: "no cache and no busy
indicator"). The scanner, the Course picker model and Recent Courses (ADR 0022, 0032, 0041) keep
their contracts; what changes is when the picker is shown and what updates it. These are the
choices the spec leaves open.

## The cache

- **What it holds.** The Courses the last scan found, each as the scan names it: `name`, `folder`
  and `categories` (ADR 0032), so a nested Course comes back from the cache exactly as the scan gave
  it. The scan's order (A–Z) is kept; nothing is sorted again.
- **Where.** The global storage, under the key `courseScanCache` (`src/core/course-scan-cache.ts`),
  as a plain JSON value `{ version: 1, roots, courses }`. The spec says "global storage"; it is
  per machine and never set for Settings Sync, like Recent (ADR 0041) and `coursesRoots` (ADR
  0022). It is **not** in a Course folder and not a `.followalong` file: it describes the learner's
  library, not a Course, and a Course folder must never be changed for it (story 106). It is not
  Course data (ADR 0005), so its rules (D5, the fallback storage) do not apply to it.
- **Per Courses roots.** The cache records the roots it was scanned from and is used only for
  exactly those roots, in that order (the order decides which root files a Course found under two).
  After a root is added or removed the cached Courses are not shown, so a Course of a root that was
  removed never lingers; the picker then opens as on a first run.
- **A cache that cannot be used is a cache that is not there.** A value of another version, of
  another shape, or that is not JSON-like is ignored, never repaired: the next scan writes a fresh one.
  The shape can grow, with a new `version`.
- **Writing it never fails the picker.** If the global storage refuses the write, the scan result
  is shown all the same and one warning goes in the log.

## Opening and updating

- **Shown at once.** `UiSink.openPicker(model, onToolbarButton)` shows a quick pick the core can
  replace while it is open (`LivePicker.update`) and answers with the picked intent, as `pick` does.
  `QuickPickModel` gains `busy` (the adapter shows VS Code's busy indicator) and `toolbar` (buttons
  in the title bar). The Lesson picker and the other pickers keep `pick`.
- **Cached Courses first.** The picker opens with the cached Courses, the Recent Courses and
  _Add Courses root…_, busy, and the scan runs in the background each time it opens (spec: "rescanned
  in the background on each picker open"). Its result replaces the list, the busy indicator goes,
  and the cache is saved. With no cache (a first run, other roots) the list is only Recent and
  _Add Courses root…_, busy, with the placeholder "Looking for Courses under your Courses roots…".
- **The picker is usable while it is busy.** A cached Course can be picked before the scan ends.
  If its folder was deleted since the last scan, opening it fails with the messages of ADR 0041 and
  the list drops it when the scan lands. A typed filter, the highlighted item and the scroll position
  stay when the list is replaced (the adapter keeps the active item by its label).
- **Recent Courses.** Which of them are missing is looked at when the picker opens and again when a
  scan lands, as before, not each time the busy indicator changes: pressing Refresh shows the busy
  indicator in the same turn.
- **Unreadable Courses roots** are named in one warning per root and window (ADR 0022) when the scan
  that found them lands, as before, now after the picker is shown.
- **A scan that fails** (anything but a folder that cannot be read, which the scan reports as
  `unreadableRoots`) is logged as an error, the busy indicator goes, and the list stays as it was.

## Refresh

- **A title bar button**, `Refresh` (codicon `refresh`), not a list item: pressing it does not close
  the picker. The core gets its intent (`{ type: 'refreshCourses' }`), shows the busy indicator
  at once and starts a new scan. The result replaces the list and the cache, so a Course downloaded a
  moment ago shows up (story 13).
- **One walk at a time.** A picker opened while a scan of the same roots is running joins it; Refresh
  always starts a new one, and of two scans the later one's result is the one shown and cached: a
  walk that a newer one overtook is dropped. A scan that ends after the picker was closed is still
  cached, so the next open is fresh; nothing cancels a walk, because the File system port has no way
  to (and a half-finished walk is of no use).

## Considered options

- **Wait for the scan when there is no cache.** Rejected: the first open would wait, as it does
  today, and the picker has the Recent Courses to offer meanwhile.
- **Refresh as an item of the list (like _Add Courses root…_).** Rejected: an item closes the picker
  and reopens it; the spec says button, and the learner keeps their typed text and place.
- **The cache as a file in the extension's storage folder.** Rejected: a library of hundreds of
  Courses is about 100 KB as JSON, which global state holds, and the Storage port's key-value store
  is already what Recent uses and Seam 1 fakes. A file is the answer if the cache ever grows large.
- **Keep other roots' Courses in the cache and filter by root.** Rejected: a Course's category path
  is relative to its root, a root added later can overlap, and a rescan is the right way to learn
  what a new root holds.

## Consequences

- Every picker open writes the cache once its scan is done, also when nothing changed.
- A Course the learner deleted shows in the list until the scan lands; a Course downloaded since the
  last open shows when it does. Refresh is for when the learner does not want to wait for the
  automatic rescan to end.
- `UiSink` has `openPicker`, so every implementation has it (the VS Code adapter, the Seam 1 fake).
  The smoke test waits for the picker to stop being busy before it picks a Course.
