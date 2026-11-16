# The bundled ffmpeg: a minimal LGPL build, made from pinned sources in CI

Ticket #43 (user story 73). Spec #12 (_Further Notes_): "ship an LGPL ffmpeg build limited to AAC
decode and MP3 encode, with its license notice in the .vsix". ADR 0034 made the sidecar run ffmpeg;
this ADR is where that ffmpeg comes from, and what the `.vsix` carries so shipping it is lawful.
Plan and conditions were approved by the orchestrator (session answer on #43); the rationale is below.

## What ships

`bin/ffmpeg.exe` in the `win32-x64` `.vsix` (about 3.5 MB; the whole `.vsix` about 2 MB), with `bin/FFMPEG-LICENSE-LGPL-2.1.txt`, `bin/LAME-LICENSE-LGPL.txt`, `bin/FFMPEG-BUILD.txt`
(versions, sources, checksums, configure options, what ffmpeg reports about itself), the build script
`scripts/build-ffmpeg.mjs` and `scripts/bundled-ffmpeg.json`, and an entry in `THIRD_PARTY_NOTICES.txt`
next to pdf.js's (decision D8 on #12). `npm run package` stops with a message naming the build script
when `bin/` lacks any of the four files, so a `.vsix` never ships the program without its licence.

## How it is made

- **Pinned sources, checked.** FFmpeg 7.1.1 (`ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz`, SHA-256
  in `scripts/bundled-ffmpeg.json`) and LAME 3.100 (SourceForge, also pinned there). The script tries
  each URL of `scripts/bundled-ffmpeg.json` in order and accepts the first whose bytes match; a changed
  tarball fails the build, it is never trusted. The ffmpeg hash was taken from the byte-identical
  `ffmpeg_7.1.1.orig.tar.xz` in the Ubuntu pool, the second URL, because `ffmpeg.org` cannot be reached
  from the agent environment this was written in.
- **Cross-compiled on Linux**, in the CI `ffmpeg` job on `ubuntu-latest`, with mingw-w64
  (`x86_64-w64-mingw32`). No pre-built Windows binary is downloaded: the popular ones are GPL builds
  with unknown flags, and a binary of unknown origin cannot carry the notice this ADR promises. Nothing
  big is committed: `bin/` is git-ignored.
- **Only what the sidecar runs:** the `mov` and `matroska` demuxers (the MP4 and WebM readers),
  parsers for the common video and sound codecs (so ffmpeg can read the stream list of a Lesson), the
  `aac` decoder, `libmp3lame` (LAME) as the MP3 encoder, the `mp3` muxer, the `file` protocol, and the
  `aresample` and `anull` filters. `--disable-everything --disable-autodetect --disable-network`, no
  `ffprobe`, `ffplay`, device support or video scaler. **No `--enable-gpl`, no `--enable-nonfree`, no
  `--enable-version3`.** A Lesson whose sound is not AAC and not one the page plays itself (AC-3, say)
  therefore fails to convert and shows _Play without sound_ (ADR 0055): spec #12 chose "AAC decode and
  MP3 encode" and every MP4 Lesson measured in research 01 is H.264 + AAC.
- **One standalone file.** LAME and libgcc are linked statically, and threads are the Windows ones
  (`--enable-w32threads`), so there is no `libwinpthread` to ship. The build and CI list the DLLs the exe
  imports (`bcrypt`, `kernel32`, `msvcrt`, `shell32`) and fail on any outside the Windows system set.
- **Cache and artifact.** The `ffmpeg` job caches `bin/` under a key made of the hash of the build script
  and the pinned file, and the cross-compiler's package version (so a new mingw-w64 builds again). A hit
  skips the build, which takes about five minutes cold. The job uploads `bin/` as the artifact
  `ffmpeg-win32-x64`; the Windows job `needs:` it, downloads it into `bin/`, runs `npm run package`, and
  runs the ffmpeg.exe unpacked from the `.vsix`.

## The LGPL compliance of the `.vsix`

- **Notice and licence texts** travel with the file: `THIRD_PARTY_NOTICES.txt` (what it is, which
  licence, what it was built with and without), the full LGPL 2.1 text of FFmpeg and the LGPL text of LAME.
- **Source.** FFmpeg here is unmodified, with no patch. The exact tarballs and checksums are in the
  notice and in `bin/FFMPEG-BUILD.txt`; the build script and its settings ship in the `.vsix`, so anyone
  holding it can rebuild the same program. The notice is also the written offer: a copy of the tarballs
  on request, at cost, for three years after the version is last distributed.
- **Relinking and replacing.** `ffmpeg.exe` is a separate program FollowAlong starts, not code linked
  into it. A user who wants a modified ffmpeg builds it from the sources and points
  `followalong.ffmpegPath` at it (ADR 0071); that is the freedom LGPL §6 protects.
- **Checked by CI, not by a human reading a log.** `scripts/check-bundled-ffmpeg.mjs` runs the unpacked
  `.vsix`'s `ffmpeg.exe` and fails unless `ffmpeg -L` prints the GNU **Lesser** General Public License,
  version 2.1 or later, and never the GPL's wording, and `-version` and `-buildconf` hold none of
  `--enable-gpl`, `--enable-nonfree`, `--enable-version3` and do hold `--enable-libmp3lame`. (`-version`
  itself prints no licence line; `-L` is where ffmpeg states it. The build step also reads
  `FFMPEG_LICENSE` from the build's `config.h`, which must be "LGPL version 2.1 or later".) The same script
  then runs the repository's own converter adapter, bundled with esbuild, over the AAC MP4 fixture
  `test/fixtures/media/sidecar.mp4`: the probe must find `aac`, and the conversion must write MP3 frames.
  That step is a CI step after packaging, not part of the smoke test: the smoke test runs the extension
  from the source tree on Ubuntu as well as Windows, where there is no `bin/ffmpeg.exe`, and it must
  check nothing the other seams cover. It is not a new test either: the converter adapter's one test file is
  the recorded D11 exception on #12 and is not widened.

## Considered options

- **Commit the binary.** Rejected: a binary in git stays in every clone for ever, cannot be reviewed,
  and nothing would tie it to the sources and flags the notice names.
- **Download a ready-made Windows build in CI.** Rejected: unknown flags and licence (most are GPL),
  and a checksum of a binary says nothing about how it was made.
- **Shared libraries (`ffmpeg.exe` and DLLs).** Rejected for one standalone file; the sources, the build
  script and `followalong.ffmpegPath` give the same ability to replace the program.
- **An MP3 encoder other than LAME** (ffmpeg has none of its own; `libshine` is a lower-quality
  fixed-point one). LAME is LGPL, and the converter already asks for it (`-c:a libmp3lame -q:a 4`,
  ADR 0034), so changing the encoder would change the sound the tests and the player were made for.
- **Other platforms.** The `.vsix` is Windows x64 (ADR 0004). On Linux and macOS the bundled path is
  absent and the sidecar uses `followalong.ffmpegPath` or ffmpeg on PATH (ADR 0071).
