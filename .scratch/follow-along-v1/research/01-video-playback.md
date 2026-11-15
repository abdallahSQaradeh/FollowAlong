# Research 01: Can VS Code play the Course videos?

Ticket: `../issues/01-can-vscode-play-the-course-videos.md`
Date: 2026-11-14. Tested on VS Code 1.146.0 (Electron 43.8.6, Chromium 150.0.7871.250, Windows 11 x64).

## TL;DR

- **The video picture plays, but MP4 audio is silent.** In a webview, H.264 video plays, seeks, pauses and changes rate correctly. AAC audio decodes **zero bytes**, and **all 324 real course MP4s are H.264 + AAC**. VS Code ships a cut-down `ffmpeg.dll` without AAC, on purpose (licensing), and the fix has been open since 2022.
- **WebM fails as `<video src>` but works through MediaSource.** All 114 WebM files are VP8 + Vorbis. With `<video src>` they fail to open (`DEMUXER_ERROR_COULD_NOT_OPEN`). Fed through **MediaSource Extensions (MSE)**, the same file **plays with sound**.
- **Recommended path:** stay in the webview.
  - WebM: play through MSE.
  - MP4: on first open, make a small **audio-only sidecar** (AAC to MP3 or Vorbis) with ffmpeg and keep it in sync with the muted `<video>`. Or remux to `-c:v copy -c:a libmp3lame`.
  - Either way, an ffmpeg binary is needed. It is not on this machine today.
- mpv contradicts the no-Focus-change goal. A local HTTP server alone fixes nothing, because decoding is the problem, not transport.

## 1. Codec support in VS Code webviews

### What VS Code ships (primary sources)

- **microsoft/vscode#156558, "Add proprietary codecs to FFmpeg"** (closed 2022-08-18). The plan asked for H.264, VP8, VP9, AAC, WAV, MP3 and Opus. Legal approved only **Vorbis, Flac, H.264, VP8, WAV, MP3, Ogg**. AAC, VP9 and Opus were _not_ approved. https://github.com/microsoft/vscode/issues/156558
- **VS Code 1.71 release notes, "FFmpeg codecs support"**: lists exactly Vorbis, Flac, H.264, VP8, WAV, MP3, Ogg. https://code.visualstudio.com/updates/v1_71#_ffmpeg-codecs-support
- **microsoft/vscode#167685, "Add support for AAC codec in webviews to read MP4 audio correctly"**: **open** since 2022-11-30. https://github.com/microsoft/vscode/issues/167685
  - Measurement on Windows, VS Code 1.141: in MP4, AAC, Opus, AC-3 and ALAC are silent, while MP3, FLAC, Vorbis and PCM decode. `.webm`, `.mkv` and others fail with `DEMUXER_ERROR_COULD_NOT_OPEN`. https://github.com/microsoft/vscode/issues/167685#issuecomment-6114497365
  - Workaround reported in the thread: `ffmpeg -i in.mp4 -c:v copy -c:a libmp3lame out.mp4` plays with sound.
- **microsoft/vscode#343048** (closed 2026-11-06). VS Code maintainer deepak1556: "AAC is not in our supported list of codecs … Any expansion to this list should go through legal approval process." He also fixed codec _detection_, so `canPlayType` and similar APIs now report the gap correctly. https://github.com/microsoft/vscode/issues/343048
- **microsoft/vscode#329811** (closed). The product `libffmpeg`/`ffmpeg.dll` lacks the AAC decoder. Swapping in stock Electron's ffmpeg restores AAC. A maintainer points back to #156558: "we only ship a subset". https://github.com/microsoft/vscode/issues/329811
- Related open issue for the integrated browser: microsoft/vscode#289795.

### Local verification of the shipped `ffmpeg.dll`

File: `C:\Users\pc\AppData\Local\Programs\Microsoft VS Code\69047191fc\ffmpeg.dll` (2.8 MB). I called its exported `avcodec_find_decoder` through ctypes:

| Decoder                      | Present |
| ---------------------------- | ------- |
| h264                         | **yes** |
| aac                          | **no**  |
| hevc, av1, vp9, opus, theora | no      |
| vp8, vorbis, mp3, flac       | yes     |

The DLL contains no `matroska,webm` demuxer name. That fits WebM failing as a plain `src`.

So yes: **H.264 is included on Windows; AAC is not.**

### Empirical webview probe

Setup: a throwaway extension in an isolated VS Code instance (`--user-data-dir`, `--extensionDevelopmentPath`) with `localResourceRoots: [D:\Learning]`, playing real course files through `asWebviewUri`. Raw result (abridged):

| Test                                                                      | Result                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')`               | `""` (detection now honest)                                                 |
| `canPlayType('video/webm; codecs="vp8, vorbis"')`                         | `probably`                                                                  |
| `MediaSource.isTypeSupported` webm vp8+vorbis / mp4 avc+aac / mp4 avc+mp3 | true / false / false                                                        |
| WebCodecs `AudioDecoder` mp4a.40.2 / `VideoDecoder` avc1                  | false / true                                                                |
| MP4 faststart (720p, 368 s)                                               | metadata ok, video decodes, **audio 0 bytes**                               |
| MP4 moov-at-end (1080p, 666 s)                                            | same: video ok, **audio 0 bytes**                                           |
| WebM via `<video src>`                                                    | error 4, `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed` |
| WebM via MSE (first 8 MB appended)                                        | buffered 0–128 s, plays, **video and audio bytes decoded**                  |

So:

- **MP4:** fine for picture, silent for sound.
- **WebM:** works only through MSE. Chromium's own WebM parser handles that path, while `src` playback goes through FFmpeg's demuxer, which VS Code left out.
- MSE does **not** rescue MP4 (`isTypeSupported` false even with MP3 audio). WebCodecs cannot decode AAC either.

## 2. Seek, pause, playbackRate, keyboard with local files

Measured in the same probe on both MP4s (video track):

- **Range requests:** `fetch(asWebviewUri, {Range: 'bytes=100-199'})` returns **206** with `Content-Range: bytes 100-199/51632629`. Moov-at-end MP4s (204 of 325 files) load and seek fine.
- **Seek:** a jump to about 60% of the duration fired `seeked` in 110–146 ms.
- **playbackRate:** at 2.0 the video advanced 4.02 s per 2 s of wall time. At 0.5 it advanced 1.0 s.
- **Pause:** `paused === true`, and `currentTime` stayed frozen.
- **Autoplay:** unmuted `play()` without a user gesture was rejected once (`NotAllowedError`). Muted autoplay works. A user click or command satisfies the policy.
- Webview docs: local files must go through `Webview.asWebviewUri`, and access is limited to `localResourceRoots`. The extension sends commands with `webview.postMessage()`. `getState`/`setState` is the preferred persistence. `retainContextWhenHidden` "has high memory overhead". https://code.visualstudio.com/api/extension-guides/webview
- **Keyboard (design note, not tested):** the docs don't cover webview keybindings. The robust pattern:
  1. Register extension commands with `keybindings` (contributes) so they fire while the _editor_ has focus.
  2. Forward them via `postMessage` to the `<video>`.
  3. The learner never focuses the webview.

  In-webview keys (when the webview has focus) are plain DOM `keydown` handlers.

## 3. Fallbacks for the AAC problem

Library size: **62.6 GB, about 160 h** of MP4 (324 files with a valid `moov`).

| Option                              | How                                                                                                                                                                                                                                                       | Cost                                                                                                                                                                                                                                                                                                             | Fits "no Focus change"?   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **A. Audio sidecar** (recommended)  | On first open, `ffmpeg -i in.mp4 -vn -c:a libmp3lame -q:a 4 cache/x.mp3`, or Vorbis/WebM. Play the muted `<video>` with a hidden `<audio>` and drive both from one controller: re-sync `currentTime` on seek/rate/pause, correct drift above about 0.1 s. | Disk: about 1 MB/min, so roughly 10 GB for 160 h at 128 kbps, and only for lessons actually opened. Time: audio-only encode, estimated at well over 50x realtime on a modern CPU, so seconds per lesson (**not measured**: no ffmpeg here). Needs an ffmpeg binary, e.g. bundled per-platform or the user's own. | Yes                       |
| **B. Remux with MP3 audio**         | `ffmpeg -i in.mp4 -c:v copy -c:a libmp3lame -movflags +faststart out.mp4` (workaround reported in #167685).                                                                                                                                               | Same encode time as A, plus a full copy of the video stream (I/O-bound, a few seconds per GB). Disk grows by up to the library size (62.6 GB) unless outputs are cached or evicted. Simplest playback: one element, no sync.                                                                                     | Yes                       |
| C. External mpv over JSON IPC       | `mpv --input-ipc-server=\\.\pipe\followalong` takes JSON commands (`seek`, `set_property speed`, `cycle pause`) over a named pipe on Windows. https://mpv.io/manual/master/#json-ipc                                                                      | Plays everything, no transcode. But it is a **separate OS window**. `--ontop` or `--wid` embedding can fake it, but the window does not follow VS Code's editor layout and takes focus on click. Needs mpv installed.                                                                                            | **No** (contradicts goal) |
| D. Local HTTP server                | Serve files from the extension over `http://127.0.0.1`.                                                                                                                                                                                                   | Changes nothing by itself: decoding happens in the same Chromium + VS Code `ffmpeg.dll`, and `asWebviewUri` already supports range requests (206). Useful only as a transport for on-the-fly ffmpeg output, which still needs ffmpeg.                                                                            | n/a                       |
| E. Decode AAC in the webview (WASM) | mp4box.js demux plus a WASM AAC decoder or ffmpeg.wasm, then Web Audio API synced to the video.                                                                                                                                                           | No native binary. High complexity (A/V sync, memory, CPU). Fallback if bundling ffmpeg is unacceptable.                                                                                                                                                                                                          | Yes                       |
| F. Swap VS Code's `ffmpeg.dll`      | Replace it with stock Electron's (#329811 shows this restores AAC).                                                                                                                                                                                       | Modifies the user's install, is overwritten on every update, and has licensing questions. A personal hack, not shippable.                                                                                                                                                                                        | Yes                       |

Also, `canPlayType`/`isTypeSupported` now report the gap correctly (#343048). The extension can feature-detect at runtime and skip the fallback if a future VS Code ships AAC.

## 4. Codecs of the actual files (`D:\Learning`)

`where ffprobe` found nothing (no ffprobe or ffmpeg on PATH). Nothing was installed. Instead I parsed container headers directly with a small Python script: MP4 `stsd` sample-entry fourcc, the `esds` object type, `moov` position, and WebM `CodecID`.

- **MP4 (325):** 323 are `avc1` (H.264) + `mp4a`, 1 has an extra `text` (subtitle) track. **All 324 audio tracks are AAC** (esds object type 0x40). One `.mp4` is actually an MP3 with an ID3 header, in a non-coding folder.
- **Faststart:** 121 have moov before mdat, 204 have moov at end. Both play, thanks to range requests.
- **WebM (114):** all **V_VP8 + A_VORBIS**.
- Sample across course folders (all `avc1` + `mp4a`/AAC):
  - Principled AI Coding / `3. Know Your IDKs.mp4` (faststart)
  - Tactical Agentic Coding / `10. rd-framework-context-window-mastery-v1 mp4.mp4` (faststart)
  - Become an Agentic Architect / `017 Full-Stack Integration Patterns with CrewAI.mp4` (720p, faststart)
  - JavaScript The Advanced Concepts / `lesson126.mp4` (1080p, moov at end)
  - ML Systems That Don't Suck / `032 - Session 17 - Model Quality Baseline.mp4`
  - Practical AI Agent Workflows / `Part-4.mp4`
  - Trading / Lessons 2, 3, 10, 11 (non-coding, out of scope but same codecs)

## Open questions for later tickets

- How to ship ffmpeg: bundle per-platform (size, license: an LGPL build with libmp3lame is fine), or require the user's install?
- Sidecar (A) vs remux (B): sync complexity vs disk cost. A quick prototype would settle it.
- Keybinding set and `postMessage` protocol for player control from the editor.
