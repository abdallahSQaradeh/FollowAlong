# Verbatim and device paths are not Courses roots; a drive-root Course is labelled with its drive

Two edge cases of ADR 0022 that review of #33 found, fixed in #34.

- **`\\?\D:\Learning` and `\\.\…` are not full paths on Windows.** They name a folder another
  way, so the drive-letter upper-casing of ADR 0022 missed them and the same folder counted as a
  second root, against ADR 0005 (one spelling per folder). Normalising them (strip the prefix,
  map `\\?\UNC\server\share` to `\\server\share`) was the alternative; a root named that way is
  rare, the `\\.\` device namespace (`\\.\PhysicalDrive0`) is no folder the learner means, and
  rejecting them reuses the existing “not a full path” warning, whose example (`D:\Learning`)
  shows the spelling to use. `isFullPath` rejects a `\\?\` or `\\.\` prefix with either
  separator; POSIX is unchanged.
- **A Course that is a drive root is labelled with the drive.** `basename('D:\')` is empty, which
  left the Course picker entry without a label. The label is the drive (`D:`), or `/` on POSIX; a share root keeps its share name
  (`\\server\share` is “share”).
  The volume label would need a new File system port call for one rare layout, and the drive
  letter is what the learner typed as the root.
