# Recent Courses: the list, the picker, known Courses, and the open Course

#35 adds the **Recent Courses** to the Course picker (spec #12, stories 3, 9 and 19). `ScannedCourse`
and `scanCourses` of ADR 0022/0032 stay as they were; Recent is read beside the scan. These are the
choices the spec leaves open, and three fixes to the open path that the reviews of #33 and #34
routed here.

## The list

- **Kept per machine, in the global storage**, under the key `recentCourses`: a plain array of
  absolute folders, newest first (`src/core/recent-courses.ts`). Not in the workspace storage (it
  is the learner's, across workspaces) and never set for Settings Sync (`D:\Learning` on one PC is
  not on the next, as for `coursesRoots`, ADR 0022). It is not a `.followalong` file, so it has no
  version envelope: an entry that is not a full path is ignored when read, so the shape can grow.
- **At most 5.** The spec says "the 5 most recently opened"; the list stores exactly that many, so
  a Course opened a sixth time ago is forgotten. Opening a Course puts it first, once; a Course that
  fails to open (no Lessons, missing folder) is not recorded. The restored Course of a workspace
  counts as opened: it is open in this window.
- **One spelling**, the one of ADR 0022: resolved, and on Windows with an upper-case drive letter.
  Two spellings of one folder (compared without letter case on Windows) are one entry.
- **Comparing folders.** Whether two paths name one Course, for the _(open)_ tag and for picking the
  open Course again, is `sameFolder`: both resolved (no `.`/`..`, no trailing separator), the drive
  letter upper-cased, and on Windows without regard to letter case. `C:\a\` and `C:\a` are one
  Course.
- **Recording Recent never fails an open.** A failing write is logged as a warning; the Course is
  open all the same.

## The picker

- **Recent Courses first**, under a _Recent Courses_ separator, newest first; the rest under _Other
  Courses_, A–Z. With no Recent Course the picker is as before, with no separators.
- **A Course is listed once.** Story 4's "every Course under my roots listed A–Z" is read as "so I
  can start one I haven't opened yet" (its reason): a Recent Course is not repeated in the A–Z list,
  as the Command Palette does not repeat a recently used command. A typed filter never shows one
  Course twice.
- **The placeholder** says "Type a Course name to open it" whenever Recent is not empty, also with
  no Courses root: the learner has Courses to pick.
- **Recent Courses outside the Courses roots** (opened with a folder URI, later with _Browse…_)
  are listed too, and with no Courses root at all the picker is the Recent list and _Add Courses
  root…_.
- **A Recent Course is named and filed as the scan names it** (ADR 0032: outermost wrapper, category
  path) when the scan finds it, and by its folder name otherwise.
- **`(open)`** is the description of the Course open in this window, wherever it is listed, after
  its category path (`Web / Frontend · (open)`). It is matched when the learner types.
- **Missing.** A Recent Course the scan did not find, whose folder cannot be listed (`notFound`: moved,
  renamed, or on a drive that is not there), shows as `missing`, with two item buttons, _Locate…_
  and _Remove_ (`QuickPickItemModel.buttons`, drawn with codicons by the VS Code adapter). A folder
  that exists but cannot be read is not missing: opening it says why. Picking a missing Course
  itself does what _Locate…_ does, rather than failing with "the folder is missing". _Remove_
  drops it from Recent. Both show the picker again; so does cancelling the folder dialog of
  _Locate…_ (ADR 0042).
- **The scan treats Recent Courses as known Courses.** `scanCourses` takes the Recent folders as a
  third argument, and a known folder is a Course even when its Lessons are only in subfolders, the
  walk stopping there (ADR 0032). So a Course opened once, from Recent, a folder URI or _Browse…_,
  is listed as itself and not as its Sections. It falls back to the scan's reading when it leaves
  Recent: a Course with a `.followalong` folder stays known on its own.

## The open path

- **Picking the Course that is open keeps what plays.** When the Course picked is the open one and a
  Lesson is loaded, nothing is reloaded: the Lesson is not restarted, paused or moved, and the
  player and the tree only come to the front. The alternative, reopening it as a restart does (paused,
  5 s before the saved position), would interrupt a playing Lesson for no reason, and #33's note asks
  for "no reload". With no Lesson loaded (the learner closed the player) it opens as before, at the
  last Lesson played. The cost: picking the open Course no longer re-reads its folder; a new window
  or another Course is how it is read again. Two Seam 1 tests of #58 that used a second
  `openCourse` of the same Course for "VS Code starts again" now call `restart()`.
- **A refused click says so.** While a Course opens (`switching`), a Lesson click, Next, Previous
  and _Go to Lesson…_ each show one info message, "FollowAlong is opening a Course…", where the
  first was silent and the others said "no Lesson is open".
- **A failed open leaves the open Course alone.** The open stores the new Course's folder in the
  workspace storage before it makes it the open Course. If that write fails, the Course that was
  open still is, with its tree, and no click plays a Lesson of the new Course by matching its id.
  (The Lesson that played was already left; it does not restart by itself.)

## Considered options

- **Keep every Course ever opened.** Rejected: the spec says 5, and the list is for returning to
  what the learner studies now.
- **Show a Recent Course in both lists.** Rejected: the same name twice when typing.
- **Persist the missing state.** Rejected: it is looked at each time the picker opens, so a drive
  that comes back is found at once.
- **A confirmation for _Remove_.** Rejected: a Recent entry is a shortcut, and the Course comes back
  when it is opened again.

## Consequences

- A global-storage write per open, and up to five folder reads per picker open for the Recent Courses
  the scan did not find.
- A Recent folder that holds Lessons only deeper down, such as a category folder opened by mistake,
  becomes one Course and its children are not listed beside it, as with a `.followalong` folder
  (ADR 0032). It leaves the list after five other opens, or with _Remove_ once it is missing.
- Recent is not carried to another machine; so is `coursesRoots`.
- Windows letter case beyond the drive letter is not normalised (ADR 0022): a Course opened with
  another spelling is a second entry until the first leaves the list.
