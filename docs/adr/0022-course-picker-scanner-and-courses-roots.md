# The Course picker, the Course scanner and the Courses roots setting

_Open Course…_ (`Ctrl+'` `C`) opens the **Course picker**: a quick pick of every Course under the
learner's Courses roots, A–Z. It replaces the folder dialog of #13. `Ctrl+'` `L` opens it too while
no Course is open (story 35). This first slice (#33) lays down the three parts #34–#40 build on:
the setting, the scanner and the picker model. These are the choices spec #12 leaves open.

## The `followalong.coursesRoots` setting

- An array of absolute folder paths, empty by default. Its `scope` is **`machine`**: it can only be
  set in user settings (the spec's "user-level") and Settings Sync does not carry it to another
  machine, where the same paths rarely exist (`D:\Learning` on one PC is not on the next).
- The core reads it through the Config port when the picker opens, keeps only non-empty strings,
  and writes it through a new `Config.update(name, value)`, which the VS Code adapter sends to the
  user settings (`ConfigurationTarget.Global`).
- Paths are used as written, never normalised: a Course's path is its root's spelling joined with
  folder names, so the same Course always has the same spelling, as ADR 0005 needs for the
  fallback-storage key.

## The Course scanner (`src/core/course-scanner.ts`)

`scanCourses({fileSystem, logger}, roots)` is pure apart from the File system port, and returns
`{courses, unreadableRoots}`. Its contract:

- **A Course is the first folder on a branch that directly holds a Lesson file** (`.mp4` / `.webm`,
  any case: `isLessonFile` of ADR 0007). The walk does not go below it: its subfolders are its
  Sections, so the Course model, not the scanner, decides about them. A root that directly holds a
  Lesson is itself a Course.
- **Not walked:** hidden folders (a leading `.`, so `.git` and `.followalong`) and `node_modules`,
  through the same `isSkippedFolder` as the Course model. Entries that are neither file nor folder
  (symbolic links, junctions) are ignored, so a link loop cannot trap the scan.
- **No depth limit**, one folder at a time (ADR 0007's reason: a drive root as a root must not open
  thousands of folders at once).
- **Unreadable folders.** A subfolder that cannot be read is logged and left out, and the walk goes
  on. A root that cannot be read (missing, an unplugged drive, no permission) is logged and
  returned in `unreadableRoots`; the core tells the learner with one warning per root, and lists
  the other roots' Courses.
- **Order and duplicates.** Courses are sorted A–Z by name with the natural order of ADR 0007
  (`lesson2` before `lesson10`, the fixed `en` collator), ties by path. A folder found twice (one
  root inside another) is listed once.
- **Names.** In this slice a Course is named after its folder. #34 changes the naming (the
  outermost single-child wrapper), adds the category path and the known-Course and zip-only rules,
  inside this same function and contract.

## The Course picker model (`src/core/course-picker.ts`)

`buildCoursePicker({hasRoots, courses})` is pure and returns the generic `QuickPickModel` of
ADR 0011, drawn by the same adapter. The intents:

- `{type: 'openCourse', folder}` opens the Course **in place of the open one, without a
  confirmation** (story 16): Progress is saved as it goes, so there is nothing to confirm.
- `{type: 'addCoursesRoot'}` asks for a folder through a new `UiSink.chooseFolder` (the OS folder
  dialog), appends it to the setting unless it is there already, and **opens the picker again**,
  so the learner picks a Course from the root just added. Cancelling the dialog changes nothing.

The items: the Courses, then _Add Courses root…_ last, which is always there; with no root it is
the only item. The placeholder says what to do: add a root, no Course found, or type a name.
Later tickets add intents and entries to this model: Recent and _(open)_ (#35), the Progress line
(#36, which reads Progress itself: the picker takes what to show, never a Progress store), _Hide_
(#38), _Browse…_ (#39) and _Open in new window_ (#40).

## Overlapping opens: the latest one wins

`openCourse` counts the opens it starts. An open whose folder and Resources reads finish after a
later open started changes nothing (logged), so two quick picks can never leave the earlier Course
open with the later one's player.

## The player keeps its page across Courses under the Courses roots

ADR 0002 made a new webview panel for every Course, because `localResourceRoots` is fixed at
creation. That cost the learner the click that lets the player start playback (#12 D3, ADR 0008)
at every switch, and moved the tab. Two changes:

- **The panel is kept.** `PlayerPanel.show` with other roots sets `webview.options` with the new
  `localResourceRoots` on the open panel. VS Code reloads the page in the same panel, which posts
  `ready`, and the core loads the Lesson as for a new page (`show` still answers `created`). The
  panel is never disposed on a switch, so `Player.onDidClose` cannot fire for it, and the tab stays
  in its editor group.
- **The roots rarely change.** Measured in the smoke test on VS Code 1.146 (Windows, CI run
  43813403964): the reload loses the click. The picked Course's Lesson was refused autoplay
  (`paused {byUser: false}`) in the kept panel. So the core now gives the player the **Courses
  roots** as its folders, plus the Course folder only when it is outside every root, plus the
  extension storage. Switching between Courses under the roots keeps the same roots: `show`
  answers `revealed`, the same page loads the next Lesson, and it still has the click. The smoke
  test asserts it: after one click, a Course picked under the same root starts by itself. A
  Course outside the roots, or a changed `coursesRoots` setting, reloads the page once.

The cost: the player page may read any file under the Courses roots, not only the open Course's.
The roots are folders the learner named for their Courses, and the page is FollowAlong's own,
with a nonce CSP and no remote content, which only fetches the URIs the core sends it.

## Considered options

- **Only the open Course's folder, with a kept panel.** Rejected after the measurement: every
  switch reloads the page and asks for a click again.
- **A wide fixed root (the drive, the home folder).** Rejected: no reload ever, but the page could
  read nearly everything on the machine.
- **The scanner names Courses and the picker sorts them.** Rejected: the scan result is what #37
  caches, so it carries its final order and names.
- **A folder dialog for _Open Course…_ beside the picker.** Rejected: the spec replaces it, and
  _Browse…_ (#39) opens folders outside the roots inside the picker.

## Consequences

- `Config` has `update`, and `UiSink` has `chooseFolder`; every implementation (the VS Code ones,
  the Seam 1 fakes) has them.
- A read-only Course keeps its Resources in the extension storage, keyed by its absolute path
  (ADR 0005), so they do not follow a Course folder that is moved or renamed; the Course then shows
  under its new path without them. This picker lists Courses by their current path only; #35's
  _Locate…_ is where a moved Course is re-pointed.
