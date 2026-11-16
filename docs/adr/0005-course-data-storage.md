# Course data: created on first write, versioned JSON, read-only detected by trying

`openCourseData(course, ports)` (`src/core/course-data.ts`) reads and writes FollowAlong's own files
for a Course. Each file is `{ "version": n, "data": … }` (pretty-printed JSON), and each kind of
file is a `CourseDataFile<T>` with its current version and a `parse(data, version)` that also
migrates older versions; a file that is not valid JSON, not in that envelope, from a newer version,
or that `parse` rejects is ignored with a warning in the log. Writes go through the File system
port's `writeText`, which writes a temp file and renames it over the target. The temp file is synced
to disk before the rename, so a crash cannot leave an empty file under the real name. A rename
that fails with `EPERM`/`EACCES`/`EBUSY` is retried for about 0.8 s, because on Windows a file
another process has open for a moment cannot be replaced. A rename still refused with
`EPERM`/`EACCES` after that (a read-only attribute on the file, another owner) counts as
`readOnly`: the data then goes to the fallback (story 107) instead of failing the command. A
`.followalong` that exists as a file also counts as `readOnly`.

Where the files go is decided by the first write: FollowAlong creates the hidden `.followalong`
folder in the Course and writes there. `attrib +H` runs on Windows for that folder once per opened
store, also when the folder already existed. If creating the folder or writing the temp file fails
because the Course is not writable (the File system port reports `readOnly` for `EACCES`, `EPERM`,
`EROFS`), it logs one info line. From then on, for the rest of the session, it uses
`<extension storage>/courses/<folder name>-<first 16 hex of sha256(absolute path)>/`. The folder
name has characters other than letters, digits, space, `.`, `_` and `-` replaced, and is cut to
60 characters. Reads look in `.followalong` first, then in the fallback folder. After a fall back,
the order flips, so this session's newer fallback copy wins and files only in `.followalong` stay
readable.

## Considered options

- **Create `.followalong` when the Course opens.** Rejected: opening a Course then changes the
  Course even when FollowAlong has nothing to keep.
- **Check writability up front (`fs.access(W_OK)`).** Rejected: on Windows it reflects only the
  read-only attribute, which does not stop new files in a folder; ACLs do. Trying the real write is
  the only check that matches what will happen.
- **Fallback folder named by the path alone.** Rejected: Windows paths can exceed the length
  limit once nested in the extension storage. The hash keeps it short and unique; the folder name
  keeps it findable by hand.

## Consequences

- The fallback key is the absolute path as given. The Course picker must pass the same spelling of
  a path each time (Windows paths are case-insensitive).
- A Course that becomes read-only after FollowAlong wrote to it keeps its old `.followalong` files.
  In a later session, reads prefer them over the newer fallback files until a write falls back
  again, unless the file defines a `merge`: then both copies are read and merged. Progress does
  (ADR 0010).
- `load` returns the value together with the copies that exist but were ignored (`unreadable`), so
  a writer can refuse to replace a file it cannot read (spec #12, D5; ADR 0010). `read` is `load`'s
  value.
- `.followalong` is created without its parents (ADR 0010), so a write never makes a Course folder
  that moved away while open; it fails with `notFound` instead.
