# Research 01: Can the player webview stream a remote video URL?

Ticket: issue #123, "Can the player webview stream a remote video URL?" (child of the map "Lessons
from a URL or an external video site").
Date: 2026-11-20. Desk research against the sources' `main` branches, plus one local ffmpeg
experiment. Earlier measurements in VS Code 1.146.0 (Electron 43.8.6, Chromium 150) come from
[research 01 of v1](../../follow-along-v1/research/01-video-playback.md). Nothing here was run inside
VS Code: the claims marked **unverified** need a probe in a real webview.

## TL;DR

| #   | Question                         | Answer                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Playback                         | **Works** for an `https` MP4 (H.264 picture, the same silent AAC as local). **Works with CORS** for WebM, through our MediaSource path. **Breaks** for HLS in practice: hls.js needs MP4 with AAC in MediaSource, which VS Code's build refuses. Native HLS is **unknown**.                                                                                                                                         |
| 2   | Content Security Policy          | **Works** once `media-src` (and `connect-src` for WebM and HLS) names the host. The webview service worker does not touch remote requests, so Range goes straight to the server. A plain-`http` source **breaks**: the webview is a secure context. A NAS on a private IP may also meet a Local Network Access permission (**unknown**).                                                                       |
| 3   | Sound                            | **Degrades.** The AAC problem comes back unchanged. A sidecar needs ffmpeg to read the URL, and the bundled ffmpeg is built with `--disable-network`. A network-enabled ffmpeg reads the **whole file** to make the MP3: 100 % of the bytes, measured. That is on top of what the player streams.                                                                                                      |
| 4   | Seeking                          | **Works** with HTTP Range. **Breaks** without it: Chromium marks the source as streaming, and `seekable` becomes `[0, 0]`. A moov-at-end MP4 without Range does not open at all (measured with ffmpeg; Chromium expected the same, unverified).                                                                                                                                                       |
| 5   | What degrades                    | The zoom is **not affected**: no canvas, only a CSS transform. Progress, resume, and moving to the floating window or mini strip **work with Range**, re-buffering from the network on each move. They **break without Range**: back to 0:00. Lesson durations in the tree **work**: they come from saved Progress.                                                                               |
| 6   | Failure                          | 404, 401 and an unreachable host all end as `MEDIA_ERR_SRC_NOT_SUPPORTED` (4), the same code as a bad codec. A drop mid-Lesson fires `stalled`/`waiting`, then Chromium retries, then `MEDIA_ERR_NETWORK` (2). Authentication: VS Code answers only proxy logins, so an HTTP-auth server **breaks** unless the credentials are in the URL (a signed URL).                                                     |

## Where the code stands today

- The player page's CSP is `default-src 'none'; media-src ${cspSource} blob:; connect-src ${cspSource}; …`
  (`src/player/page.ts:25-32`). `cspSource` is VS Code's `'self' https://*.vscode-cdn.net`
  (`webviewGenericCspSource`,
  [`webview/common/webview.ts:29-33`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/common/webview.ts)).
  So today **no remote host can load**.
- Media URLs come from `asWebviewUri`, limited to `localResourceRoots` (`src/adapters/vscode/player-panel.ts:283-288, 318-323`).
  `localResourceRoots` governs only local files. It has no say over `https://` URLs
  ([webview guide, "Controlling access to local resources"](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/webview.md)).
- MP4 plays from `<video src>` (`src/player/main.ts:259`). WebM plays through MediaSource: `WebmSource` `fetch`es the bytes,
  with `Range: bytes=N-` for re-streams, and skips N bytes when the answer is not 206
  (`src/player/webm-source.ts:263-271`, ADR 0006).
- The zoom is a CSS transform on `.zoom-frame` (ADR 0037). No canvas is read anywhere in the player: `canvas` appears only in the PDF viewer.
- The sidecar runs ffmpeg on a file path (`src/adapters/node/converter.ts`, `soundArguments`). The bundled build has
  `--disable-network`, `--enable-protocol=file` and `--disable-autodetect`
  (`scripts/bundled-ffmpeg.json:27-42`, ADR 0070).

## 1. Playback

**Remote MP4.** A `<video src="https://…">` fetches through Chromium's media loader, not through VS Code.
VS Code's webview service worker answers only three kinds of request:

1. a request to `*.vscode-cdn.net` (its own resource host);
2. a request to the remote authority;
3. a request to `localhost`/`127.0.0.1`/`0.0.0.0` with a port.

Everything else falls through to the network
([`service-worker.js:349-395`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/service-worker.js)).
Decoding is the same either way, so the codec picture of research 01 holds unchanged:

- H.264 and VP8 video, and MP3, Vorbis, FLAC, WAV and Ogg sound;
- **no AAC** ([webview guide, "Supported media formats"](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/webview.md):
  "VS Code will be able to play the video part of the `mp4`, but since `AAC` audio is not supported there won't be any sound").

So a remote H.264+AAC MP4 plays picture-only, exactly like a local one.

**Remote WebM.** VS Code's ffmpeg has no Matroska demuxer, so WebM fails as `<video src>` (research 01). It needs
our MediaSource path, which uses `fetch()`. A cross-origin `fetch()` needs the server to send CORS headers.

- **Origin.** The webview's origin is `vscode-webview://…`. It is a registered secure, CORS-enabled scheme
  ([`src/mainImpl.ts:111-115`](https://github.com/microsoft/vscode/blob/main/src/mainImpl.ts)), so the server must
  answer `Access-Control-Allow-Origin: *` or that exact origin.
- **Range.** `Range: bytes=N-` is a CORS-safelisted request header when it holds a single range, so it needs
  no preflight ([MDN, CORS-safelisted request header](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header)).
- **Status.** The response status is readable, which is all `WebmSource` checks (`webm-source.ts:267-271`).

**HLS (`.m3u8`).**

- **hls.js.** hls.js feeds MediaSource with fMP4. It transmuxes MPEG-2 TS to fMP4 and passes fMP4 through
  ([hls.js README](https://github.com/video-dev/hls.js/blob/master/README.md), "fMP4 segments … are passed
  through to MSE without remuxing, while MPEG-2 TS and Packed Audio … are transmuxed into fMP4").
  - In VS Code, `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')` is `false`
    (research 01, measured). Nearly every HLS stream carries AAC, so the audio SourceBuffer cannot be made.
  - `Hls.isSupported()` can still say yes. It accepts any one of `avc1+mp4a`, AV1, VP9, `audio/mp4 mp4a.40.2`
    or `audio/mp4 fLaC` ([`src/is-supported.ts`](https://github.com/video-dev/hls.js/blob/master/src/is-supported.ts)),
    and Chromium's MP4 MediaSource parser lists FLAC and Opus without proprietary codecs
    ([`stream_parser_factory.cc`, `kVideoMP4Codecs`](https://github.com/chromium/chromium/blob/main/media/filters/stream_parser_factory.cc)).
    So the feature check passes, and the failure comes later, as an hls.js error.
  - An AAC-free HLS stream (H.264 video only, or Opus/FLAC audio) might work. `avc1` alone in MediaSource
    was **not measured** in VS Code.
- **Native HLS.** Chromium compiles its HLS demuxer when `proprietary_codecs` is on
  (`enable_hls_demuxer = proprietary_codecs`,
  [`media/media_options.gni:124-125`](https://github.com/chromium/chromium/blob/main/media/media_options.gni)).
  Electron builds with `proprietary_codecs = true`
  ([`build/args/all.gn:62-63`](https://github.com/electron/electron/blob/main/build/args/all.gn)), so the code
  is probably in VS Code's binary. Two things are **unknown**:
  - whether it is switched on at run time;
  - what it does with AAC segments and VS Code's cut-down ffmpeg.

  hls.js itself warns that Chrome's `canPlayType('application/vnd.apple.mpegurl')` "reports support but may
  fail to play certain assets natively" (README, "Getting started"). At best the sound would be silent,
  as with MP4.

- **Our sidecar cannot follow a live or segmented stream** without reading the whole playlist's audio
  (see question 3).

**Verdict:** MP4 works (silent AAC, as today). WebM works with CORS. HLS breaks for the common
H.264+AAC stream.

## 2. Content Security Policy, the service worker, and the network rules around them

**What the CSP must allow.**

- `media-src` must list the host, or `https:`, for `<video src>`.
  The page's own CSP governs this: VS Code's outer frame CSP does not cover the inner document
  ([MDN, `media-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/media-src)).
  `blob:` stays for the MediaSource object URL.
- `connect-src` must list the same host for `fetch()`: WebM through MediaSource, and every hls.js playlist
  and segment request
  ([MDN, `connect-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)).
- hls.js's UMD build runs its transmuxer in a Web Worker it makes from a blob
  ([README](https://github.com/video-dev/hls.js/blob/master/README.md)), so it would also need `worker-src blob:`.
  VS Code only allows `data:`/`blob:` workers anyway
  ([webview guide, "Using Web Workers"](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/webview.md)).
  The other choice is `enableWorker: false` ([hls.js API.md](https://github.com/video-dev/hls.js/blob/master/docs/API.md#enableworker)).
- The CSP should name the Lesson's own origin, built per page, rather than a blanket `https:`. The VS Code
  guide asks for the narrowest policy and https only (webview guide, "Content security policy",
  "Only load content over https").

**The service worker and Range.** A remote request never reaches `processResourceRequest`
(`service-worker.js:349-395`, above). So the service worker neither helps nor hurts. Range requests and
206 answers go between Chromium's media loader and the server, as in a browser. The service worker's own
Range handling, and its `416` for multi-range requests, apply only to local resources (`service-worker.js`,
`processResourceRequest`).

**Two network rules the ticket did not name. Both matter for "a home NAS".**

- **Mixed content.**
  - `vscode-webview` is registered with `secure: true` (`mainImpl.ts:111-115`), and Electron treats such a
    scheme as secure, like https
    ([Electron `protocol.registerSchemesAsPrivileged`](https://github.com/electron/electron/blob/main/docs/api/protocol.md)).
    So the player page is a secure context.
  - Browsers "auto-upgrad[e] image, video, and audio mixed content requests from HTTP to HTTPS, and block
    insecure requests for all other resource types"
    ([MDN, Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)).
  - So `<video src="http://192.168.1.10/a.mp4">` is tried as `https://…` and fails on a NAS without TLS.
    A `fetch()` to `http://` (WebM, HLS) is blocked outright.
  - `http://localhost` and `http://127.0.0.1` are exempt: they count as secure (same MDN page, "Loading
    locally delivered mixed-resources").
  - **Plain-http sources break.**
- **Local Network Access.**
  - Chromium is gating requests from a public context to private IPs and `.local` names behind a user
    permission ([WICG LNA explainer](https://github.com/WICG/local-network-access/blob/main/explainer.md),
    "Permission prompts").
  - VS Code adds `local-network-access` to the webview iframe's `allow` list when Chromium supports it
    ([`webviewElement.ts:434-441`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/webviewElement.ts)).
  - **Unknown:** how a `vscode-webview:` page is classed, and whether VS Code ever grants or prompts.
    Needs a probe against a NAS.
- **Cross-origin isolation (edge case).**
  - Desktop VS Code is cross-origin isolated only with `--enable-coi`
    ([`environmentMainService.ts:64`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/electron-main/environmentMainService.ts)).
  - The webview then gets `Cross-Origin-Embedder-Policy: require-corp`
    ([`pre/index.html:1103-1104`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/index.html),
    `service-worker.js:514-523`).
  - Under `require-corp`, a cross-origin no-CORS video needs a `Cross-Origin-Resource-Policy` header
    ([MDN, COEP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)).
  - Not the default. Noted only so a bug report with that flag can be explained.

## 3. Sound

**It comes back unchanged.** The sound is decoded by the same build (question 1), so an AAC MP4 from a URL
is silent and needs the sidecar of ADR 0034. A remote MP3, Opus or FLAC MP4 needs none (ADR 0056's
`soundCodecs` check applies as is).

**ffmpeg can read the URL, but not the one we ship.**

- ffmpeg's `http`/`https` protocols take a URL as input, with `seekable`, `headers`, `reconnect*` and
  `multiple_requests` options
  ([`doc/protocols.texi`, "http"](https://github.com/FFmpeg/FFmpeg/blob/master/doc/protocols.texi)).
- `https` needs a TLS back end: `tls_protocol_deps_any="gnutls openssl schannel securetransport libtls mbedtls"`
  ([`configure`](https://github.com/FFmpeg/FFmpeg/blob/master/configure)). On Windows, `schannel` is the
  OS's own and is autodetected, which `--disable-autodetect` turns off.
- So the bundled build would need three changes:
  - drop `--disable-network`;
  - add the `http`, `https`, `tcp` and `tls` protocols, with `--enable-schannel`;
  - for HLS, add the `hls` and `mpegts` demuxers, plus `aac` for packed audio
    (`hls_demuxer_select`, same file).
- Licensing does not change: schannel is a system library, and none of this needs `--enable-gpl`.
  `followalong.ffmpegPath` pointing at a full ffmpeg would work today.

**What it costs: measured.** The experiment used Ubuntu's ffmpeg 6.1.1 (the bundled one is 7.1.1, but the
`mov` demuxer reads the same way). The input was a 5-minute 720p H.264 + 128 kb/s AAC MP4 of 98.9 MB.
A local server, written for this, counted the bytes it sent. The command was our converter's own arguments
(`-map 0:a:0 -vn -c:a libmp3lame -q:a 4 -map_metadata -1 -f mp3`) with an `http://127.0.0.1` input.

| Server                  | File          | Bytes ffmpeg pulled | Requests | Result                                                                                                                                               |
| ----------------------- | ------------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Range                   | faststart     | 98.9 MB (100 %)     | 1        | good 1.2 MB MP3, 1.48 s                                                                                                                              |
| Range                   | moov at end   | 100.5 MB (102 %)    | 3        | good MP3, 1.48 s                                                                                                                                     |
| no Range (always `200`) | faststart     | 98.9 MB (100 %)     | 1        | good MP3, 1.47 s                                                                                                                                     |
| no Range                | moov at end   | 98.9 MB (100 %)     | 1        | **237-byte MP3, exit code 0.** ffmpeg logged `partial file` / `Stream ends prematurely` / `Error during demuxing: Input/output error`, and still exited 0 |
| local file (baseline)   | faststart     | (disk)              | —        | 1.46 s                                                                                                                                               |
| Range                   | `missing.mp4` | —                   | —        | `Server returned 404 Not Found`, non-zero exit                                                                                                        |

What this shows:

- **The sidecar downloads the whole Lesson.** MP4 interleaves sound and picture, so reading every sound
  sample reads nearly every byte. Over loopback the time equals the local time, because the encode is
  CPU-bound. Over a real link it is at least size ÷ bandwidth: a 1 GB Lesson on a 100 Mbit/s line is about
  80 s before the sound is ready.
- **And it downloads it twice.** The player streams the same file for the picture, so a Lesson costs about
  twice its size in transfer, unless one download serves both (see "New open questions").
- **The "next three Lessons" queue (ADR 0081) becomes three whole downloads ahead.** That is fine on a LAN
  and heavy on a metered link.
- **The cache limit (ADR 0096) still bounds the MP3s.** It does not bound transfer.
- **The converter cannot trust ffmpeg's exit code for network input.** A truncated read still exits 0 with
  a near-empty MP3. ADR 0034's "a finished file is a whole one" needs a guard: ffmpeg's `-xerror`, or a check
  of the MP3's duration against the probe's. **Unverified** on 7.1.1, though the behaviour is the demuxer's.

## 4. Seeking

**With Range** it works as it does locally. Chromium notes `Accept-Ranges: bytes`, or treats any valid `206`
as range support
([`resource_multi_buffer_data_provider.cc:432-455`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/media/resource_multi_buffer_data_provider.cc)).
It then fetches the bytes at the seek target. A 206 is the standard answer to a range request
([MDN, HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)).
Each seek to unbuffered media costs a round trip to the server instead of a disk read. ffmpeg showed the
same: a seek to 4:00 pulled 10 MB in 2 requests with Range.

**Without Range** it breaks:

- **What the server does.** It answers `200` with the whole body
  ([MDN, Range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests):
  "If range requests are not supported, an `200` `OK` status is sent back and the entire response body is transmitted").
- **What Chromium makes of it.** Its media source is `streaming_` when the range is not supported
  ([`multi_buffer_data_source.cc:602-604`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/media/multi_buffer_data_source.cc)).
  For a streaming source with a finite duration, `seekable` is `[0, 0]`: only a seek to the start, kept so
  looping works
  ([`web_media_player_impl.cc`, `Seekable()`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/media/web_media_player_impl.cc)).
- **What the learner gets.** The seek bar, the seek steps (ADR 0013), resume (ADR 0016) and a `startAt`
  cannot move the playhead.
- **A moov-at-end MP4 cannot even open.** Its index is at the end of the file, and the demuxer cannot go
  back for it. ffmpeg failed exactly so, and pulled 84 MB to reach 4:00 without Range. Chromium is expected
  to fail the same way, but that is unverified: 204 of the 325 local MP4s were moov-at-end (research 01).

**Compared with a streamed WebM (ADR 0006).**

- **With Range**, the WebM path carries over: `WebmSource` already re-streams from a Cluster with
  `Range: bytes=N-`, given CORS.
- **Without Range**, `WebmSource` already copes. It skips N bytes of a `200` (ADR 0006, `webm-source.ts:271`),
  so a seek back still lands. But each re-stream downloads from byte 0 to the target: over a network that is
  the whole file up to the seek point, every time.
- **The WebM path can seek where the MP4 path cannot.** It does its own fetching, so without Range a WebM
  still seeks (slowly) while an MP4 cannot.

## 5. What degrades

- **Zoom to a dragged area (ADR 0037): not affected.**
  - A cross-origin video drawn into a canvas without CORS taints it. Reading pixels back then throws
    `SecurityError`
    ([MDN, "Security and tainted canvases"](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image#security_and_tainted_canvases)).
  - FollowAlong's zoom never draws the video into a canvas. It scales a frame around the `<video>` with a
    CSS transform (ADR 0037; `canvas` occurs only in `src/player/pdf-*.ts`).
  - So nothing taints, and no `crossorigin` attribute is needed. Adding `crossorigin` would make the plain
    MP4 path need CORS too ([MDN, `crossorigin`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/crossorigin)),
    so leave it off.
- **Progress and resume (ADR 0010, 0016).**
  - **Work with Range.**
  - **Break without it:** the start seek cannot land (question 4), so every reopen starts at 0:00.
  - Progress itself (`timeUpdate`, `ended`) still flows.
  - A live or unknown-length HLS stream reports `duration` Infinity, which the player sends as 0
    (`src/player/main.ts:566-568`). The "done in the last 5 %" rule then never fires
    (`src/core/lesson-status.ts:36-38`), so such a Lesson becomes done only on `ended`.
- **Floating window and mini strip (ADR 0049, 0100, 0102).** A move makes a new page that takes over time,
  speed, play/pause and zoom (ADR 0049). For a remote Lesson that page loads the URL again.
  - **With Range**, it lands at the old time after a re-buffer from the network. How much the HTTP cache
    saves depends on the server's cache headers (unmeasured).
  - **Without Range**, every move or collapse restarts the Lesson at 0:00.
- **Lesson durations in the Lesson tree: work.** The tree shows `position / duration` from saved Progress
  (`src/core/lesson-tree.ts:142-143`), which the player reported once it had loaded the metadata. Nothing
  probes files for length. So a remote Lesson shows its length after its first open, as a local one does.
  A live stream shows none.
- **The ahead-of-time sound queue (ADR 0081) and the audio cache (ADR 0096).** Both still work on the MP3s,
  but each prepared Lesson is a whole download (question 3).

## 6. Failure

- **What the `<video>` reports.** Four codes: `MEDIA_ERR_ABORTED` (1), `MEDIA_ERR_NETWORK` (2),
  `MEDIA_ERR_DECODE` (3) and `MEDIA_ERR_SRC_NOT_SUPPORTED` (4)
  ([MDN, `MediaError.code`](https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code)). The player
  forwards `media.error?.message` as the Lesson's one `error` (`src/player/main.ts:641-642`).
- **404, 401, DNS failure, refused connection or mixed-content block, before the metadata.**
  - When the data source fails to initialise, Chromium sets `kNetworkStateFormatError`
    ([`web_media_player_impl.cc`, `DataSourceInitialized`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/media/web_media_player_impl.cc)).
    That surfaces as **`MEDIA_ERR_SRC_NOT_SUPPORTED` (4)**, the code an unsupported codec gets.
  - The page cannot tell "not found" from "cannot decode", so the message must not blame the format.
  - An error that names the HTTP status needs another path: a `HEAD`/`fetch` from the extension host, or the
    `fetch` that `WebmSource` already makes (it says `HTTP 404`).
- **The network drops mid-Lesson.**
  - The element first fires `stalled` ("trying to fetch media data, but data is unexpectedly not forthcoming",
    [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/stalled_event)) and `waiting`
    once the buffer runs dry ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/waiting_event)).
  - Chromium's loader retries a cut-short response up to `kMaxRetries = 30` times, with delays of 25–250 ms
    growing 50 ms per try (about 29 s in all, per its own comment)
    ([`resource_multi_buffer_data_provider.cc:64-75`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/media/resource_multi_buffer_data_provider.cc),
    [`.h`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/media/resource_multi_buffer_data_provider.h)).
  - A network or read error in the pipeline then becomes `kNetworkStateNetworkError`, which surfaces as
    **`MEDIA_ERR_NETWORK` (2)** (`PipelineErrorToNetworkState`, same file).
  - So the learner first sees a picture frozen for up to about half a minute, then the error.
  - The sidecar is a local MP3, so it keeps playing. ADR 0034 deliberately does not pause it on `waiting`
    ("a local file seldom stalls"). For a remote Lesson that becomes wrong: the sound runs on over a frozen
    picture until the next `timeupdate` pulls it back.
- **The server needs authentication.**
  - Electron's default for an HTTP auth challenge "is to cancel all authentications"
    ([Electron `app` 'login' event](https://github.com/electron/electron/blob/main/docs/api/app.md)).
  - VS Code's handler answers only proxy challenges (`if (!authInfo.isProxy) return; // only for proxy`,
    [`native/electron-main/auth.ts:75-78`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/native/electron-main/auth.ts)).
  - So a Basic or Digest-protected NAS gives a 401 and the load fails as above (code 4), with no prompt.
  - Cookies from the learner's browser are not there: the webview has its own storage.
  - **What works:** a signed or token URL (credentials in the query string). For WebM and hls.js only, a
    header added on the page's own `fetch` (hls.js `xhrSetup`/`fetchSetup`,
    [API.md](https://github.com/video-dev/hls.js/blob/master/docs/API.md#xhrsetup)), which needs the
    server's CORS to allow that header.
  - `<video src>` cannot send a header.

## Summary per question

1. **Playback: works (MP4, WebM with CORS) / breaks (HLS with AAC) / unknown (native HLS, AAC-free HLS).**
2. **CSP: works** with `media-src` + `connect-src` naming the host. The service worker does not interfere.
   **Breaks** for plain `http` (mixed content). **Unknown** for private-IP Local Network Access.
3. **Sound: degrades.** The AAC problem returns. The sidecar needs a network-enabled ffmpeg (ours has
   `--disable-network`) and downloads the whole Lesson, doubling transfer. A truncation guard is needed,
   because ffmpeg exits 0.
4. **Seeking: works with Range / breaks without** (`seekable` [0, 0]; a moov-at-end MP4 does not open).
   WebM without Range still seeks, by re-downloading from byte 0.
5. **What degrades:** the zoom **works** (no canvas). Resume, floating window and mini strip **work with
   Range** and **break without** (back to 0:00). Tree durations **work**. A live HLS has no "last 5 %".
6. **Failure:** 404/401/unreachable → code 4, indistinguishable from a bad codec. A drop → `stalled`/`waiting`,
   about 30 s of retries, then code 2. HTTP auth **breaks** (no prompt); signed URLs work.

## New open questions for the map

- **Download once, or stream?** The AAC sidecar must read every byte anyway. A remote MP4 Lesson could be
  fetched once into a local cache, then played and converted as a local file. That would fix the double
  transfer, seeking without Range, the moov-at-end case, and the sound-over-frozen-picture case. It would
  cost disk and a wait before play. Streaming suits only H.264+MP3/Opus MP4s and WebM.
- **A probe in real VS Code** (one experiment ticket) for the **unverified** points:
  - a remote `https` MP4 with and without Range, moov-at-end included;
  - an `http://` NAS URL (mixed-content upgrade, and Local Network Access on a private IP);
  - native HLS (`canPlayType` plus an actual play);
  - `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')` with no audio.
- **A network-enabled bundled ffmpeg** (`http`, `https`, `tcp`, `tls` via schannel; `hls` and `mpegts` for
  HLS). It also needs a truncation guard in the converter. This only matters if "stream and convert from
  the URL" is chosen over "download once".
- **A local loopback relay.** The extension host could serve `http://127.0.0.1:port` and relay to the remote
  server. It could add Range, CORS and auth headers, and plain-`http` NAS sources would pass, because
  loopback is a secure origin. One catch: the webview service worker intercepts `localhost:port` requests
  and may redirect them through port mapping in remote setups (`service-worker.js:392-394`,
  `processLocalhostRequest`).
- **Lesson identity for a URL.** Progress, sidecar names (ADR 0034: path, size, mtime) and the audio cache
  are keyed by local paths. A URL Lesson needs a key, and something like ETag/Last-Modified to stand in
  for size and mtime.
