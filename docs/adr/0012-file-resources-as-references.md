# File Resources are references in `resources.json`, relative inside the Course and absolute outside

A Resource is a reference to a file, never a copy (spec #12, story 95). The Resource store
(`src/core/resources.ts`) keeps them in `resources.json` in the Course data, through
`openCourseData` (ADR 0005), so it gets the `.followalong` folder, the hidden attribute and the
read-only fallback without any code of its own. The file is version 1:

```json
{
  "version": 1,
  "data": {
    "lessons": {
      "Section 1/01 Welcome.webm": [
        { "id": "…", "kind": "file", "path": "notes/cheat sheet.md", "relative": true },
        { "id": "…", "kind": "file", "path": "D:\\snippets\\x.ts", "relative": false }
      ]
    }
  }
}
```

- **Relative or absolute.** A file inside the Course folder is stored relative to it, with `/`
  separators on every OS, so the Resource survives moving or renaming the Course (the file is
  resolved against the folder the Course is opened from). Any other file is stored by its absolute
  path. A file next to the Course, or reached by `..`, counts as outside: a `..` path would break
  as soon as the Course moves alone.
- **Keyed by Lesson id.** The key is the Lesson's path in the Course (ADR 0007), not an absolute
  path, so the data moves with the Course. The file belongs to one Course, so ids need no Course
  prefix.
- **A generated `id` per Resource**, not the path. Detach and Relink (later tickets) change
  or remove a Resource without the tree losing track of which one it is.
- **Course Resources** (story 91) will add a `course` key beside `lessons`. `parse` ignores keys it
  does not know and tolerates their absence, so that ticket needs no version bump.
- **A malformed entry is dropped when read; a malformed file is ignored** (ADR 0005), and the next
  attach writes a fresh file. A file from a newer FollowAlong is ignored the same way.
- **Attaching re-reads the file before writing** and attaches in one window run one at a time, so
  two quick attaches never overwrite each other, and what another window attached since this one
  opened the Course is kept. There is no lock between windows: two attaches in the same instant can
  still lose one, and the other window's tree shows the change only when its Course is opened
  again. Progress (story 85) has the same limit and the tickets for it may add a lock for both.
- **A file that was ignored is replaced by the next attach.** `openCourseData.read` answers
  `undefined` both for "no file" and for "ignored" (damaged, or from a newer FollowAlong; ADR 0005),
  so an attach after an ignored read writes a new file. That mends a damaged file, and also
  replaces a newer FollowAlong's file if the learner runs an older build. Telling the two apart
  needs a change in `course-data.ts`, which this ticket leaves alone.
- **Opening a Course reads the Resources, and a read failure is only logged**: the Lessons still
  play without them. Attaching reads again and lets such a failure through as a command error,
  because writing after a failed read could drop what was there.
- **Opening a file is a UI sink method** (`UiSink.openFile`), not a new port: the list of ports in
  spec #12 stays as it is. The VS Code adapter runs `vscode.open` with `ViewColumn.Beside`: VS Code picks the editor for the file (text and code in
  the text editor), in the group beside the code. The player is `retainContextWhenHidden`, so a
  Resource tab in front of it does not stop the Lesson, but the learner cannot see it while the tab
  is in front: where the Resource should sit so both are visible is a Manual QA question (#64).
  The core sends the player nothing when a Resource opens, and says so in a message when the file
  cannot be opened. The tickets for previews, PDFs and URLs add targets here.
- **The file dialog stays in the adapter**, as for Open Course…: the core's `attachResource` takes a
  Lesson id and an absolute path.

## Considered options

- **Store every path relative, with `..`.** Rejected: it breaks when the Course moves and the file
  does not, which is the reverse of what the learner expects of a reference to a file elsewhere.
- **Key Resources by file path and Lesson.** Rejected: attaching the same file twice, or relinking,
  would have no stable identity for the tree.

## Consequences

- `TestHooks` (ADR 0002) now also has `lessonTree()`, the tree the learner sees, so the smoke test
  can find the id of a Resource it attached.
- The Resources of a read-only Course live in the extension storage, keyed by the Course's absolute
  path (ADR 0005), so they do not follow it when it is moved. Paths are not resolved through
  symbolic links: a Course reached through a link is "inside" by the path it was opened with.

- Nothing checks that a file still exists when it is attached or listed. Dimming a missing file and
  Relink (story 97) are a later ticket; until then clicking a Resource whose file is gone shows
  VS Code's own "file not found".
- A learner who attaches a file that is not text (an image, a PDF) gets whatever editor VS Code has
  for it, until the preview and PDF tickets add their targets.
