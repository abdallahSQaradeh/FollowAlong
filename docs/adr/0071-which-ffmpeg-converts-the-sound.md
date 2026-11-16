# Which ffmpeg converts the sound: the setting, then the bundled one, then PATH

Ticket #43 (user story 73). ADR 0034 left "the ffmpeg the sidecar runs" as the setting or ffmpeg on
PATH "until the bundled one lands". The core now picks the program for each Lesson in this order:

1. **`followalong.ffmpegPath`**, when it is a full path (as for Courses roots, ADR 0033). It always
   wins, bundled ffmpeg or not: it is the learner's way to use their own build, and the way to replace
   the bundled one with a modified one (the LGPL, ADR 0070).
2. **The bundled ffmpeg**, when the extension has one for this machine. The adapter says where it is
   (`Ports.bundledFfmpeg`): `<extension>/bin/ffmpeg.exe` on win32-x64, nothing anywhere else. The path is
   a port value, not something the core works out, so the core never reads `process.platform` for it,
   and a Seam 1 test decides it with a fake machine.
3. **`ffmpeg` on PATH**, when there is no bundled one (a Linux or macOS developer running the extension
   from source; the `.vsix` is Windows x64 only).

- **A bundled ffmpeg that is missing is a failure, not a silent fall back to PATH.** The `.vsix`
  ships the file, so its absence means a damaged install (a virus scanner took it, an update stopped
  half way). Using PATH instead would hide that, and would convert with an ffmpeg nobody chose and the
  build tests never saw. The check is the core's, before anything is started: the preparation fails with
  "The ffmpeg that comes with FollowAlong is missing (<path>). Reinstall FollowAlong, or set
  followalong.ffmpegPath to an ffmpeg you installed.", and that is the failure the learner already knows
  (ticket #42): the Sound notice, with _Play without sound_. Nothing is cached about it, so a file that
  is back, or a setting that is added, works at the next Lesson with no restart.
- **A relative `followalong.ffmpegPath` is still ignored with one warning** (once per window and value),
  and the warning says which ffmpeg is used instead: "the ffmpeg that comes with FollowAlong" where there
  is one, "ffmpeg on PATH" where not.
- **Why a port field and not a Config value.** `followalong.ffmpegPath` is the learner's; the bundled path
  is the extension's own, fixed by where the `.vsix` is unpacked. Config reads settings, so mixing them
  would let a settings file point "the bundled path" somewhere else.
- **Seam 1 covers it** (`test/unit/bundled-ffmpeg.test.ts`): with a fake config and converter and the
  real temp-dir file system, the program each probe and conversion runs, the failure of a missing file,
  and the one-time warning. The adapter's one line (`bundledFfmpegPath`) is a platform check with no
  rule in it.

Source: spec #12 (_Further Notes_: "ship an LGPL ffmpeg build limited to AAC decode and MP3 encode");
ticket #43 acceptance criteria; the orchestrator's routed notes for #43 (`ConversionRequest.program` is
the default's home, `followalong.ffmpegPath` still overrides it, a missing bundled file takes the
existing failure path).
