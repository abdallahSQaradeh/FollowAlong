# One Resource store per open Course, and a missing file is found by looking

The rules of Resources lived in `follow-along.ts` (read, re-read, write, refuse, one attach at a
time), written for attach alone. Detach and Relink (#58) need the same steps with another change in
the middle, and CP1 (ADR 0024) asked for an `openProgress`-like module for Resources. `openResources(folder, ports)`
(`src/core/resource-store.ts`) is that module.

- **Interface.** `current()`, `missing()`, `find(id)`, `checkFiles()`, and `attach`, `detach` and
  `relink`, each resolving with whether the change was made. The Course side keeps what only it can
  know: which Course is open now, the file dialogs, and the tree.
- **One change at a time, per open Course.** Each change re-reads the file first (another window
  may have changed it) and is queued behind the one before; looking at the files (`checkFiles`) waits in the same queue, so an
  older look never overwrites a newer result. A change that no longer applies (another window
  detached the Resource first) still redraws the tree, so it shows what is there now. A change is made in the store of the
  Course the learner asked it in; the tree shows it only if that Course is still open, otherwise the
  learner is told which Course it went to (ADR 0024). Relink fixes its Course before the dialog
  opens, as both attach routes do. Opening a Course again makes a new store, so the queue is no
  longer window-wide: two changes to the same Course around a re-open can interleave their
  re-reads. Each still re-reads before it writes, so only the tree can be a moment stale.
- **A missing file is found by looking.** The File system port has `exists(path)`; it answers
  `false` only for `notFound`, so a file that cannot be examined for another reason is not shown as
  missing. The store looks at every Resource when the Course opens and after each change, and
  `openResource` looks again at the one clicked, so a file that went, or came back, while the Course
  was open is noticed by the next click. A missing Resource opens nothing: it says the file cannot
  be found and points to Relink…. A file that exists but fails to open keeps ADR 0012's message.
- **`ResourceNode.missing`** is part of the Lesson tree model; the tree view dims the row (a file
  decoration), and offers Relink… on it, and Detach on every Resource, through the context
  menu (`contextValue` `resourceMissing` / `resource`).
- **The read result is not split.** CP1 suggested a Course data read that tells "missing" from
  "unusable". Not needed: the store already remembers an unusable copy and routes writes around it
  (ADR 0005), and an unusable copy on open is logged and skipped like a missing one.

## Considered options

- **Watch the Resource files.** Rejected for this ticket: a watcher per file on a network drive is
  a cost for a state the learner meets only after a click.
- **Check the file only when the tree draws.** Rejected: VS Code asks for tree items often, and each
  would stat every Resource.

## Consequences

- `pickFile` takes a `FileDialog` (title and button label), like `chooseFolder`, so Attach and
  Relink share one port method.
- The pure rules (merge, detach, relink, reference paths) stay in `resources.ts`.
