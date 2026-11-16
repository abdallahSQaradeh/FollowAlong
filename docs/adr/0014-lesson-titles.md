# Lesson titles: from a title list, or cleaned from file names

`buildCourse` (`src/core/course-model.ts`) gives every Lesson its title, using
`src/core/lesson-titles.ts`. The spec fixes the broad rule (a `.txt` **title list** whose line count
equals the Lesson count, otherwise file names with the leading number, a `Lesson N -` prefix and a
trailing ` _ <Course name>` removed). These are the details it leaves open:

- **Where the list can sit.** In the Course folder, or in a wrapper folder collapsed into it (the
  folders ADR 0007 shows no Section for). A `.txt` inside a Section is not the Course's list.
  `readFolderListing` reads the text of `.txt` files only in the Course folder and in folders below
  it that hold no Lesson of their own (possible wrappers), never in a folder that does hold
  Lessons, so a big Course does not read every text file in it.
- **Which list.** The `.txt` files are tried in natural order of their names, outermost folder
  first, and the first whose line count equals the Lesson count is used. A notes or README file
  with another line count never blocks the real list. A notes file that happens to have exactly the
  Lesson count would win; the learner renames or moves it. That is rare, and a refusal to guess
  among several fitting lists would be a worse failure (no titles at all).
- **What a line is.** Lines end in LF, CRLF or CR; a byte order mark is dropped; each line is
  trimmed; blank lines are not counted and not used (text editors add them at the end and between
  groups). Titles are used as written: the cleanup rules apply to file names only.
- **Order.** The Lesson order of the tree (ADR 0007): a folder's own Lessons, then its Sections.
- **Unreadable list.** A `.txt` that cannot be read is logged as a warning and ignored; the Course
  opens with the next list, or with cleaned file names.
- **File-name cleanup**, in this order, on the name without its extension:
  1. a trailing ` _ <Course name>` goes (case-insensitive). The Course name is the name of the
     folder the learner opened as the Course, which is the outermost wrapper when they open that
     one (ADR 0007); opening an inner folder names the Course after it;
  2. a leading number goes, with the separator after it (`01 `, `02. `, `03 - `, `04_`, `05)`),
     but not when the number is part of the title: `3D Graphics` and `1.5x Speed` keep theirs;
  3. a `Lesson N -` prefix goes (hyphen, en dash or em dash, any letter case), also after the
     number (`03 Lesson 3 - Loops`).

  Cleanup is literal: `2024 Review` loses its `2024` like any leading number, and
  `Lesson 3: Loops` keeps its prefix, since the spec names the `-` form. A name that cleanup
  would leave empty (`01.mp4`) keeps its name without the extension.

- **Ids are untouched.** A Lesson's `id` stays its path, so Progress and the pickers do not depend
  on titles.

## Considered options

- **Read every `.txt` in the Course.** Rejected: a title list is a Course-level file, and a
  `.txt` in a Section is far more likely to be notes for that Section.
- **Count blank lines.** Rejected: a trailing newline or a blank line between groups would make
  every list fail the count.
