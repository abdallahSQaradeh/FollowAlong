# The converter's temp files: plain errors, and a sweep that trusts the folder's clock

ADR 0034 has ffmpeg write a `.<name>.<pid>-<n>.part` temp file beside the output and rename it over
the output when whole. Ticket #42 fixes two things that went wrong around it (routed from #41), and
puts the adapter's parsing and process handling under tests.

- **The learner never reads the temp file's name.** A failure to create, write or rename it (a name too
  long for the folder, a full disk, a read-only fallback folder, a file another program holds) is
  turned into plain words: "the file name of the sound is too long for this folder", "the disk is
  full", "the folder is read-only", or the system's own message with the temp file's name replaced by
  the sound file's. ffmpeg's own output was already treated so.
- **The stale-`.part` sweep compares the folder's clocks, not ours.** A temp file untouched for 10
  minutes belongs to a conversion that died with its window and is removed by the next conversion in the
  folder. Its age was measured against this machine's clock, but a network folder stamps files with its
  server's clock, which may be hours away: a conversion another window was running looked ancient and
  was deleted, or a dead one never looked old. The age is now measured against the new temp file, made
  in the same folder a moment before the sweep, so both times come from the folder. A file stamped in
  the future is never stale. The rule stays in the adapter, with the file system it is about, and is
  tested there, rather than moved to the core, which has no access to the folder's clock.
- **How the adapter is tested.** `createFfmpegConverter({ start, killGraceMs })` takes the function that
  starts the process, `child_process.spawn` by default. The tests in `test/unit/ffmpeg-converter.test.ts`
  stand in for ffmpeg only: the probe parser and the progress reader run over output recorded from real
  ffmpeg runs (`test/fixtures/probe/`, made by `scripts/make-probe-fixtures.mjs`: AAC, MP3, silent, two
  sound tracks, an unreadable file, a conversion), and the kill escalation over processes that ignore
  SIGTERM or everything. The files, the temp names, the renames and the sweep are real, in a temp
  folder. CI has no ffmpeg, and a real one cannot be made to hang on cue; the recorded files are
  regenerated only when the parser or ffmpeg's output changes.

## Considered options

- **Move the sweep to the core.** Rejected: it would need the folder's clock through a port, for one
  adapter's temp files.
- **Skip files younger than a fixed age by name (a pid or a timestamp in it).** Rejected: a pid means
  nothing to another machine on a shared folder.
