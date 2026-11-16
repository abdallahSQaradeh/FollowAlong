# Detach and Relink keep a Resource's identity, and two copies of `resources.json` merge by Resource

Spec #12 (stories 96 and 97) lets the learner _Detach_ a Resource and _Relink…_ one whose file is
missing. Decision D5 (amended) says a Course data file FollowAlong cannot read is never overwritten,
and new data goes to the other location. Together they make `resources.json` a file with up to two
copies that must merge, where a detach has to survive a stale copy.

- **Detach removes the reference only.** The file on disk is never touched. There is no
  confirmation: a Resource is a reference, and the learner can attach the file again.
- **Relink keeps the Resource.** It changes where the Resource points (relative to the Course when
  the new file is inside it, else absolute: ADR 0012) and nothing else: same id, same place in its
  Lesson. A Resource opens by its stored path each time, so a relinked Resource opens at the new
  file, in the tab the placement rule of ADR 0012 / D4 names.
- **Both copies are read.** `resources.json` now has a `merge` (ADR 0005), as `progress.json` has:
  per Lesson, every Resource of either copy, in the order of the Course's copy followed by those
  only the other copy has. The same Resource in both copies is the one relinked last.
- **A detach is remembered.** Without that, a Resource detached in one copy would come back from the
  other copy at the next read. `data.detached` maps the id of each detached Resource to the time
  (`clock.now()`); a relinked Resource carries `changedAt`. Merging drops a Resource whose detach is
  at or after its last relink. Both fields are optional, so version 1 stays version 1: a file
  written before this ticket reads as before, and an attach writes exactly what it wrote.
- **Amended D5 for every Resources write.** A copy that cannot be read (damaged, from a newer
  FollowAlong, unreadable) is never replaced. The change goes to the other location, the learner is
  told once per open Course, and the next read merges both copies. When neither location can take
  the change, nothing is changed and the learner is told ("Nothing was changed."). This replaces the
  existence check ADR 0012 added for attach, which could not see the fallback copy.

## Considered options

- **Union by id, no times.** Rejected: it brings a detached Resource back, and cannot say which of
  two relinks is newer.
- **The newer whole file wins** (as for files without `merge`). Rejected: after a copy that could
  not be read is fixed, the newer fallback copy holds only what was attached meanwhile, and the
  fixed copy's Resources would be hidden.
- **Write every change to both copies.** Rejected: one of them is, by definition, not writable or
  not trusted, and the store (ADR 0005) decides where a write goes.
- **Delete the detach record when it is old.** Not done: an entry is an id and a number. A
  later ticket may prune them if a file ever grows.

## Consequences

- A detached Resource leaves `{ id: time }` behind in `resources.json` for good.
- The times come from one machine's clock. Two windows on one machine agree; a Course data folder
  shared between machines is out of scope (spec #12).
