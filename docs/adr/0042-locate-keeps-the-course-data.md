# Locate… re-points a Recent Course and carries its Course data

_Locate…_ (spec #12, story 19) points a Recent Course whose folder has moved at its new folder.
"Keeps its Progress" depends on where the Course data lives (ADR 0005):

- **A writable Course** keeps Progress and Resources in its own `.followalong`, which moved with the
  folder. There is nothing to do beyond re-pointing the entry.
- **A read-only Course** keeps them in the extension storage, in a folder keyed by the Course's
  absolute path (`<storage>/courses/<name>-<hash of the path>`). Under the new path that is another
  key, so the data would be left behind. `src/core/locate-course.ts` carries it.

## What Locate… does

1. Asks for the folder (the OS dialog, `ui.chooseFolder`). Cancelling changes nothing.
2. Reads the folder as a Course. One with no Lesson at any depth is refused with a warning naming it,
   and the entry stays as it was: it would only turn "missing" into "no Lessons".
3. Carries each Course data file, Progress and Resources, from the old key to the new folder
   through `openCourseData`, the store of ADR 0005, so the rules of the store apply unchanged:
   - the data goes where a write to the new folder goes: its `.followalong` if it is writable, the
     extension storage under the new key if it is read-only;
   - what the new folder already has is **merged** when the file has a `merge` (both files of
     today do: per Lesson and per Resource, newest wins, ADR 0010 and ADR 0039), and kept as it is
     when it has none;
   - a file in the new folder that cannot be read is **never written over** (D5 as amended): the
     store sends the data to the extension storage, and the unreadable file is left as it is.
4. Only then points the Recent entry at the new folder, in the same place in the list. If the new
   folder is already in Recent, the entry nearer the top stays.

If carrying fails, nothing is re-pointed, the learner is told, and the old data is still where it
was, so _Locate…_ can be tried again.

## Considered options

- **Copy every file of the old fallback folder.** Rejected: the store has no copy, and it would skip
  the merge and the choice of where the new data goes. Prepared sound (#41) is a cache named by the
  Lesson and its size and time, and is made again for the new key.
- **Key the fallback by something that survives a move.** Rejected: ADR 0005 chose the path, and the
  spec keys fallback Courses by absolute path.
- **Move, not copy.** The File system port has no delete, so the old key's folder stays in the
  extension storage, unread. It is small, and is what a Course moved back finds again.

## Consequences

- A new Course data file joins the two in `locateCourse` when it is added.
- The open Course is not re-pointed: if its own folder moved while it is open, _Locate…_ fixes the
  entry, and picking it then opens the Course at its new folder, like any other.
