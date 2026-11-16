# Windows folder identity: compared by key, not made canonical with `realpath.native`

On Windows two spellings of one folder that differ only in letter case name the same folder. FollowAlong
compares such folders by their key (`keyOf` in `courses-roots.ts`: the resolved path with an upper-case
drive letter, lower-cased on Windows), and keeps each path spelled as it came. It does not make paths
canonical with `realpath.native`. CP2 (agenda c on #12) looked at this again and kept it so, because
ADR 0022 left it open "for when such a split is seen".

The scan now keys the Courses it found the same way. Before, two Courses roots that overlap and differ in
letter case below the drive letter (`D:\Learning` and `D:\learning\Web`) listed each Course under both of
them twice, because the scan compared the folders as spelled (CP2 agenda b, routed from #34). The root
named first files the Course, as it does for roots spelled alike (ADR 0022).

## Considered options

- **`realpath.native` on every path the core is given.** Rejected:
  - It needs a new File system port call. The core cannot call `fs` itself (ADR 0002), and the call
    would run for every Course, every Lesson and every Recent Course the picker checks.
  - It also resolves symbolic links and junctions, which is more than letter case. A Courses root
    reached through a junction would hand the player the real folder. VS Code matches a file against
    the player's folders by spelling (`playerFolders`, ADR 0022), so a Course under that junction
    would need the real folder as a root as well.
  - A read-only Course keeps its Course data in the extension storage, keyed by its absolute path as
    spelled (ADR 0005). Making the spelling canonical changes that key for every such Course already
    played, so its Progress and Resources would be left under the old key. That would need a move of
    the data, and is the very split it is meant to prevent.
  - The split it would close (a read-only Course opened once as `D:\learning\X` and once as
    `D:\Learning\X`) has not been seen. Manual QA on Windows (#64) is where it would be.
- **Comparing by key everywhere a folder is compared** (kept). `sameFolder`, Recent Courses, Hidden
  Courses, the Course list cache, the Progress lines and now the scan all compare by `keyOf`. Each
  stays one pure function in the core, testable on every OS.

## Consequences

- A read-only Course opened in two spellings still keeps two copies of its Course data in the
  extension storage (ADR 0022). Writable Courses keep theirs in `.followalong` and are not affected.
- Revisit this if Manual QA finds that split, or if Courses under a symbolic link or junction need
  to be matched to their real folder.
