# Course names, category paths and known Courses in the scan

#34 extends the Course scanner of ADR 0022 so the learner's existing folder layout works as it is
(spec #12, stories 5, 6, 7 and 11). The scan stays one pure function of the File system port,
`scanCourses({fileSystem, logger}, roots)`; each `ScannedCourse` gains `categories`, and its `name`
changes. These are the choices the spec leaves open.

- **A Course is named after its outermost wrapper.** A folder that is not a Courses root, holds no
  Lesson itself and has exactly one Course below it is a wrapper around that Course. The walk
  hands the Course up, and every such wrapper on the way takes over the name, so the outermost
  one wins: `JavaScript The Advanced Concepts\udemy-ajconfeb\01 Intro.mp4` is listed as
  “JavaScript The Advanced Concepts”. Only folders with a Course count as the one child, as in
  the Course model's Wrapper folder (ADR 0007): a sibling that holds a zip, a PDF or nothing
  does not stop a wrapper. A folder with two or more Courses below it is a category, never a
  wrapper. The Courses root is never a wrapper: it is where the learner keeps their Courses.
  `ScannedCourse.folder` is still the folder that holds the Lessons, so opening the entry opens
  that folder.
- **A category with a single Course is read as a wrapper.** `Web\React Basics\…` with nothing else
  under `Web` is listed as “Web”: the two layouts have the same shape and the spec says
  outermost. The Course picker's _Hide_ (#38) is the way out for a learner it misleads; a second
  Course in the folder turns it back into a category.
- **The category path is the folders between the Courses root and the folder that names the
  Course**, outermost first, kept as `categories: string[]` (the scan result is what #37
  caches, so it carries data and not display text). The root's own name is not part of it. The
  Course picker shows it as the item's description, joined with `/` (VS Code matches a typed `Web/Frontend` against it as a subsequence), and sets
  `matchOnDescription`, so typing a category filters to it (story 7). A Course directly under
  its root has no description.
- **A known Course is a folder with a `.followalong` folder and a Lesson anywhere below it.** It
  is a Course even when its Lessons are only in subfolders, and the walk stops there, so those
  subfolders are not listed as Courses of their own. Without a Lesson below it is left out,
  like any folder the scan finds nothing in. Recent Courses are the other kind of known
  Course in the spec; they arrive with #35.
- **A folder that holds only a zip is not a Course**, as before: a Course needs a Lesson file.
- **A Course found under two roots is listed once, as the root named first in the setting files
  it.** Names and categories depend on the root, so the two spellings of one folder could
  differ; the setting's order is the one the learner controls.
- **No depth limit**, as in ADR 0022 and the ticket. Entries that are neither file nor folder
  (links, junctions) are still ignored, so the walk ends; a drive root still opens one folder at
  a time.

## Consequences

- The Course model still builds Lessons and Sections from the Course folder. Lesson titles strip
  a trailing ` _ <Course name>` using the Course folder's own name, which for a wrapped Course
  is the inner folder's, not the name the picker shows (Manual QA with the real layout).
- The scan reads every sibling subtree of a candidate wrapper before it decides, as the walk
  already did; a known Course reads below itself only until the first Lesson.
- A folder that holds `.followalong` ends the walk on its branch wherever it is, a category
  folder or the Courses root included: it becomes one Course, as a known Course must (the
  spec's "the scan stops there"). FollowAlong only creates the folder inside a Course.
- A folder is not taken for a wrapper when one of its subfolders could not be read, since that
  folder may hold a second Course. The unreadable folder is logged, as before.
