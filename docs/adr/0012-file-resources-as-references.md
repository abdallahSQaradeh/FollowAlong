# File Resources are references in `resources.json`, relative inside the Course and absolute outside

A Resource is a reference to a file, never a copy (spec #12, story 95). The Resource store
(`src/core/resources.ts`) keeps them in `resources.json` in the Course data, through
`openCourseData` (ADR 0005), so it gets the `.followalong` folder, the hidden attribute and the
read-only fallback without any code of its own. The file is version 1:

```json
{
  "version": 1,
  "data": {
    "course": [],
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
- **The Course-level key is reserved now.** `course` (story 91) is written as `[]` and kept as it
  is when a Lesson gets a Resource. Nothing attaches to the Course yet, but the file then needs no
  migration when that ticket, or `kind: 'url'` for URLs, arrives. A file without `course` (the
  first writes) reads as `[]`. `kind` is the discriminator of a Resource.
- **A malformed entry is dropped when read; a malformed file is ignored** (ADR 0005), and the next
  attach writes a fresh file. A file from a newer FollowAlong is ignored the same way.
- **Attaching re-reads the file before writing** and attaches in one window run one at a time, so
  two quick attaches never overwrite each other, and what another window attached since this one
  opened the Course is kept. There is no lock between windows: two attaches in the same instant can
  still lose one, and the other window's tree shows the change only when its Course is opened
  again. Progress (story 85) has the same limit and the tickets for it may add a lock for both.
- **An ignored Resources file is never overwritten.** `openCourseData.read` answers `undefined`
  both for "no file" and for a file it ignored (damaged, or from a newer FollowAlong; ADR 0005). An
  attach that read `undefined` therefore asks the File system port whether `.followalong/resources.json`
  exists. If it does, the attach is refused: nothing is written, the path is logged, and the learner
  sees one message ("FollowAlong can't update this Course's Resources file (it is damaged or from a
  newer version). Nothing was changed."). Otherwise a damaged file would be replaced, and a newer
  FollowAlong's data lost (spec #12: "versioned JSON … so later versions can migrate"). Source:
  orchestrator gate round 1, which also asked that `course-data.ts` stays untouched (#25 changes it).
  Limit: the check looks only in `.followalong`. An ignored file in the fallback storage of a
  read-only Course is not protected, because its location is a private rule of `course-data.ts`;
  exporting it would remove the limit.
- **Opening a Course reads the Resources, and a read failure is only logged**: the Lessons still
  play without them. Attaching reads again and lets such a failure through as a command error,
  because writing after a failed read could drop what was there.
- **Opening a Resource is a UI sink method** (`UiSink.openResource(target)`), not a new port: the
  list of ports in spec #12 stays as it is. The target is `{kind: 'file', path}` today; the tickets
  for opener types, URLs and PDFs add kinds and route them inside the adapter, without changing the
  method's shape. The VS Code adapter runs `vscode.open` with `preserveFocus` (focus stays where the
  learner was), so VS Code picks the editor for the file (text and code in the text editor).
- **A Resource never opens in the player's editor group**, so the video stays in sight (story 94:
  "open in a VS Code tab beside the code while the video keeps playing"). Source: orchestrator
  answer, story 94. The group is, in order: the one that already holds a Resource this window opened
  (so Resources collect in one group, also when the learner's focus is in it); else a group that is
  not the player's, not the active group and not the active editor's; else a new group at the end,
  which is to the right of the player in the usual code | player layout. If the player is not in
  an editor group (the other spots, #49), VS Code's own `ViewColumn.Beside`. The first rule is an
  addition to the orchestrator's: without it, a learner who clicks into the Resource tab and then
  opens another Resource would find the code's group as the only one that is "neither". The rule
  lives in the adapter (`resource-placement.ts`) because it is about VS Code's window layout; the
  smoke test checks it in a real VS Code. The player stays `retainContextWhenHidden` for the
  spots where it can still be covered.
- **The file dialog stays in the adapter**, as for Open Course…: the core's `attachResource` takes a
  Lesson id and an absolute path. (Revised by ADR 0024: with no path, the core asks for the file
  through `UiSink.pickFile`, so it can fix the Lesson's Course before the dialog opens.)

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
  Relink (story 97) are a later ticket. Until then, clicking a Resource whose file is gone shows
  one error message from the core (“could not open … Is the file still there?”) instead of a
  failed command.
- A learner who attaches a file that is not text (an image, a PDF) gets whatever editor VS Code has
  for it, until the preview and PDF tickets add their targets.
