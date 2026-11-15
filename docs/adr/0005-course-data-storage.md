# Course data: created on first write, versioned JSON, read-only detected by trying

`openCourseData(course, ports)` (`src/core/course-data.ts`) reads and writes FollowAlong's own files
for a Course. Each file is `{ "version": n, "data": … }` (pretty-printed JSON), and each kind of
file is a `CourseDataFile<T>` with its current version and a `parse(data, version)` that also
migrates older versions; a file that is not valid JSON, not in that envelope, from a newer version,
or that `parse` rejects is ignored with a warning in the log. Writes go through the File system
port's `writeText`, which writes a temp file and renames it over the target.

Where the files go is decided by the first write: FollowAlong creates the hidden `.followalong`
folder in the Course (`attrib +H` on Windows) and writes there. If that fails because the Course is
not writable (the File system port reports `readOnly` for `EACCES`, `EPERM`, `EROFS`), it logs one
info line and uses `<extension storage>/courses/<folder name>-<first 16 hex of sha256(absolute
path)>/` instead, for that write and the rest of the session. Reads look in `.followalong` first,
then in the fallback folder.

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
- A Course that becomes read-only after FollowAlong wrote to it keeps its old `.followalong` files;
  reads still prefer them over newer fallback files. A later ticket that writes often (Progress)
  should decide whether to merge the two.
