# The audio cache: one record across Courses, the oldest opened goes first, never what is in use

Ticket #45 (user stories 74 and 75). Prepared sound (ADR 0034, 0081) lives in each Course's
`.followalong/sound`, or in `<storage>/courses/<Course>-<hash>/sound` for a read-only Course. A limit
must hold across all of them, but only one Course is open in a window, and a Course folder may be
on a drive that is not there. The rules live in one core module (`src/core/audio-cache.ts`) behind
the File system port, which gained `remove(path)`; adapters only delete the file they are told to.

- **Which files count, and where it looks.** Every sound file FollowAlong has made or opened is
  noted in the global storage (key `audioCache`: path and when its Lesson was last opened, in a
  versioned record that another version ignores). Each time the cache looks, it also reads the
  fallback storage's sound folders and the open Course's, and adds the `.mp3` files it did not know
  (made by an earlier FollowAlong, or inside a copy of a Course), as opened on the day they were
  made. A file gone from disk (`notFound`) leaves the record, so a Course on a drive that is away
  comes back with its sound dated by when it was made, not by when it was opened; any other
  failure to look at a file skips it and is logged. Sound in a Course never opened since the record was lost, on a drive that is away, is
  found again when that Course is opened. Nothing else is looked at: other files in those folders,
  and the folders themselves, are never touched.
- **"Opened longest ago".** The record's time is when the learner last opened the Lesson (its
  sound resolved for the opened Lesson, whether made or found), from the Clock port. The sound
  made ahead for a Lesson not opened yet counts as opened when it was made. Oldest goes first, ties
  by path. Eviction deletes until the total is at most the limit.
- **Never what is in use.** The Lesson that is loaded and the next 3 (the queue's _ahead_, ADR 0081)
  are never chosen, so a tiny or zero limit leaves up to 4 files, and eviction cannot make the
  queue re-convert a sound it just made. What is in use is asked again before each deletion, not
  once at the start of a run: a Lesson the learner opens while a run is under way keeps the sound
  it was just handed. Only the moment between that look and the deleting is left open. If a Lesson
  file cannot be looked at (anything but `notFound`: a file another program locks), what is in use
  is not known, and the run deletes nothing and logs one line. Only this window knows its loaded
  Lesson: another window's loaded Lesson is protected only by being the newest, so it is the last
  to go.
- **The limit** is `followalong.audioCacheLimit`, in GB (1 GB = 1024³ bytes), default 5, minimum 0.
  Anything that is not a number of at least 0 means 5. It is read at each look, and a change to it
  prunes at once.
- **When it runs.** In the background, one run at a time with the record's own writes, after each
  sound file is made, when the first Lesson of a Course is loaded (not when the Course opens: only
  then is the sound the Course reopens on known), and when the setting changes. Playback never waits for it
  (the sound resolves before the deleting starts), and the learner is shown nothing. Whatever goes
  wrong in one run (a file another program holds open, a folder that cannot be read) is one `warn`
  line in the log, naming the first problem and how many more; the files that could not go stay,
  and the next run tries again.
- **`FollowAlong: Clear audio cache`** deletes every sound file it knows, in both stores and in every
  Course, with no confirmation (it is a cache that is made again when a Lesson is opened, unlike
  Progress, which asks first), and says how many files and how much it freed, counting only the
  files it deleted itself. It keeps the loaded Lesson's sound: the player is reading it, and
  deleting it would cut the sound mid-Lesson (on Windows the delete would be refused anyway). The
  message says so when there was such a file. It does not stop a conversion
  under way; that file appears when it is done, as the Lesson being prepared is in use.

## Considered options

- **Order by file modification time, no record.** Rejected: that is when a file was made, not when
  its Lesson was opened, so the Lesson played yesterday would go before one converted ahead today.
- **Touch the file on each open** (a `utimes` on the File system port). Rejected: a second new port
  method, and a write to a folder that may be read-only, where the fallback storage is used.
- **Find every sound by listing the known Courses** (Recent, the Course list cache). Rejected:
  Recent holds 5 Courses, and the cache depends on the Courses roots, so sound of other Courses
  would count against no limit.
- **Clear the loaded Lesson's sound too**, as the ticket's words "all sidecar MP3s" read. Rejected on
  the orchestrator's rule that the loaded Lesson's sound is never deleted.

Source: spec #12 (_Sound for MP4 Lessons_, stories 74 and 75; _Audio sidecar service_ → size limit);
ticket #45 acceptance criteria; ADR 0034 (where sound lives, atomic writes), ADR 0081 (the queue,
"pruning belongs to ticket #45"); the orchestrator's routed notes for #45.
