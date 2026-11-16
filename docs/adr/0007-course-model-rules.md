# The Course model: how a folder becomes Sections and Lessons

`buildCourse` (`src/core/course-model.ts`) turns a folder listing into Lessons and Sections, and
`readFolderListing` (`src/core/folder-listing.ts`) reads that listing through the File system port.
The spec fixes the broad rules (videos at any depth, folders holding videos are Sections,
single-child wrappers collapse, natural order, `.followalong` left out). These are the details it
leaves open, chosen so a Course shows the same on every machine and every re-open:

- **A Lesson is a `.mp4` or `.webm` file, in any letter case.** Its `id` is its path in the Course
  with `/` separators (`Section 1/01 Welcome.webm`), and a Section's `id` is its folder path with a
  trailing `/`, so the two never collide. Its title comes from a title list or
  from the cleaned file name (ADR 0014).
- **Order.** In a folder, its own Lessons come first and its Sections after, each sorted by natural
  order: an `Intl.Collator('en', { numeric: true, sensitivity: 'base' })`, ties broken by plain
  comparison. The locale is fixed, so the order does not depend on the learner's machine. The first
  Lesson to play is the first in this order (Lessons of the Course folder, then the first Section
  depth-first).
- **Wrapper folders.** A folder that holds no Lessons of its own and exactly one Section is a
  wrapper: it collapses into that Section's content and keeps its own (outermost) name, as the
  Course name will in the scanner ticket. It applies to the Course folder too, so a Course whose
  only subfolder holds the Lessons shows them directly. Folders that hold no video at any depth are
  left out, so they never make a wrapper or a Section.
- **Folders never read.** Hidden folders (a leading `.`, which covers `.followalong` and `.git`)
  and `node_modules`. Entries that are neither a file nor a folder (symbolic links, devices) are
  ignored.
- **Unreadable folders are skipped.** A subfolder that cannot be read (Windows "System Volume
  Information" when a drive root is the Course) is logged as a warning and left out, and the walk
  carries on. The Course folder itself failing still fails the open: a missing folder shows its
  message, anything else is an error. This is the note the orchestrator left on #14 after the review
  of #63.
- **A folder with no Lessons is still opened as the Course.** The tree shows the message “found no
  Lessons (.mp4 or .webm) … If the Course is zipped, extract it first.” (and the same text pops up
  as a warning), so the learner is never left with an empty tree and no reason. A video that is
  already playing keeps playing.

## Considered options

- **Mix Lessons and Sections in one natural-order list.** Rejected for now: real Courses hold
  either Lessons or Sections in a folder, and "Lessons first" keeps the first Lesson to play the same
  as #13 chose, with no surprise when a stray video sits next to the Section folders.
- **Walk folders in parallel.** Rejected: opening a drive root as a Course would open thousands of
  folders at once. One at a time is fast enough for a local disk.

## Consequences

- The scanner ticket (Courses roots, Course naming) reuses `isSkippedFolder` and the wrapper rule.
- Lesson ids are relative to the Course, not unique across Courses: whoever stores something per
  Lesson (Progress) keys it by Course as well.
