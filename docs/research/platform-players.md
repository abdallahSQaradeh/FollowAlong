# Research: YouTube and Vimeo players in the player webview

Ticket: _Can YouTube and Vimeo players be embedded in and controlled from the player webview?_
(child of _Map: Lessons from a URL or an external video site_). Date: 2026-11-20. Throwaway
branch `research/platform-players`; not merged.

## How the sources were read

- **Read directly:** VS Code source (webview host and Simple Browser), Chromium source (Blink
  referrer and scheme registry), Electron source (content client schemes), and the Vimeo Player SDK
  README (`vimeo/player.js`).
- **Read through search extracts only:** `developers.google.com`, `support.google.com`,
  `www.youtube.com`, `developer.vimeo.com` and `oembed.com` do not resolve from this session's
  network. Claims about the YouTube IFrame API, the YouTube terms, Vimeo embed options and the Vimeo
  Developer Addendum come from search-engine extracts of those first-party pages. The URLs below are
  the pages themselves. Check the wording on the live pages before anything depends on it.
- **The repo as it is:** the player page's CSP is `default-src 'none'; media-src <cspSource> blob:;
connect-src <cspSource>; img-src <cspSource> data:; style-src 'nonce-…'; script-src 'nonce-…'`
  (`src/player/page.ts`). It has no `frame-src`, so today no iframe can load at all.

## 1. Embedding

**The frame itself can load.** VS Code's own Simple Browser is a webview whose CSP has `frame-src *`
and which loads arbitrary https pages in an `<iframe sandbox="allow-scripts allow-forms
allow-same-origin allow-downloads">` ([simpleBrowserView.ts][sb-view]). Neither YouTube's nor
Vimeo's embed URL is meant to be blocked by frame headers, because embedding is what they are for.
The player page would need `frame-src https://www.youtube-nocookie.com https://player.vimeo.com`.
For the YouTube IFrame API it would also need `script-src https://www.youtube.com` (the API loader
is fetched from YouTube) plus whatever the loader pulls in. Vimeo's SDK is an npm package
(`@vimeo/player`) that can be bundled into the player script, so it needs no remote script
([player.js README][vimeo-readme]).

**The webview's origin sends no Referer, and YouTube now requires one. This is the blocker.**

- A desktop webview's documents are served from `vscode-webview://{{uuid}}`
  ([environmentService.ts][vsc-env]). The content frame is written into `fake.html` on that same
  origin, and nothing sets a referrer policy ([pre/index.html][vsc-pre]).
- Blink sends no referrer when the referrer's scheme is not in `allowed_in_referrer_schemes`
  ([security_policy.cc][cr-policy]). That set starts as `{"http", "https"}` and only grows through
  `RegisterURLSchemeAsAllowedForReferrer` ([scheme_registry.cc][cr-schemes]). Electron's
  `AddAdditionalSchemes` never fills `referrer_schemes` ([electron_content_client.cc][el-content]).
  So an iframe request from the player page to YouTube goes out with no `Referer`. (This is read
  from the source and not measured. A prototype should confirm it.)
- Since July 2025 YouTube's Required Minimum Functionality says that API clients using the embedded
  player "must provide identification through the HTTP Referer request header". For apps, it says
  the Referer domain must be the app's store-registered application ID, and that wrappers should
  also pass that ID as `widget_referrer`. A missing Referer gives player error **153** ("video
  player configuration error") ([RMF][yt-rmf], [IFrame API reference / revision history][yt-api],
  [embed help][yt-help]). Chrome extension pages hit the same 153 for the same reason
  ([chromium-extensions thread][cr-ext-153]), and so do iOS and React Native WebViews
  ([react-native-webview #3855][rnw-153]).
- An extension cannot set request headers on a webview's subframe navigations. VS Code offers no
  such API, and the webview host only forwards messages. So the only workaround in reach is a
  **relay page on a real https origin that FollowAlong controls** (for example a static page the
  project hosts). The webview frames the relay, and the relay embeds YouTube with its own Referer
  and passes API calls through with `postMessage`. That adds a hosted dependency, and FollowAlong
  has none today. YouTube's rule for apps asks for a store app ID, and whether a VS Code Marketplace
  extension ID counts as one is **unknown**.
- The `origin` player parameter expects "the URL scheme (http:// or https://) and full domain of
  your host page" ([player parameters][yt-params]). A `vscode-webview://` origin is neither, which
  is one more reason for a relay page.

**Vimeo.** Vimeo checks the Referer only when the owner limits embedding to specific domains, and a
missing Referer then gives the privacy error "because of its privacy settings, this video cannot be
played here" ([Vimeo referrer troubleshooting][vimeo-ref], [player errors][vimeo-errors]). Videos
that may be embedded anywhere should load without a relay. Domain-limited ones (common for paid
courses hosted on Vimeo) will not load, relay or not, unless the relay's domain is on the owner's
list.

**Privacy modes.** `youtube-nocookie.com` is YouTube's privacy-enhanced mode: views do not
personalise recommendations or ads ([embed help][yt-help-pem]). It does not remove the Referer
rule. Vimeo's `dnt=1` stops session data and analytics cookies, and only a few security cookies
remain ([Vimeo player cookies][vimeo-cookies], [embed options][vimeo-embed]).

**Codecs (a new risk).** VS Code's Chromium cannot decode AAC (ADR 0034). YouTube picks its streams
through MSE type checks and has VP9/AV1 with Opus, which the webview decodes (ADR 0056 lists Opus).
That should work, but it is not measured. For Vimeo no source says which audio codec its adaptive
streams use in a browser without AAC. Chromium builds without proprietary codecs report Vimeo
failures and silent playback ([Opera forum][opera-aac]; low trust). This is **unknown** and needs a
prototype.

## 2. Control

| Player needs (ADR 0003, 0015) | YouTube IFrame API ([reference][yt-api])                                                                                                                                           | Vimeo Player SDK ([README][vimeo-readme])                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| play / pause                  | `playVideo()`, `pauseVideo()`                                                                                                                                                      | `play()`, `pause()` (promises; `PasswordError`, `PrivacyError`)                                                                                                                                               |
| seek                          | `seekTo(seconds, allowSeekAhead)`                                                                                                                                                  | `setCurrentTime(s)`; `RangeError` outside 0…duration                                                                                                                                                          |
| speed                         | `setPlaybackRate`, `getAvailablePlaybackRates` (per video, always ≥ `[1]`); an unsupported rate is rounded towards 1; the change is a request, confirmed by `onPlaybackRateChange` | `setPlaybackRate` 0–2, `playbackratechange` event; needs the owner's `speed` embed option on, and the README still says "PRO and Business accounts" ([embed options][vimeo-embed], [speed help][vimeo-speed]) |
| position, duration            | `getCurrentTime()`, `getDuration()` (no time event: poll)                                                                                                                          | `getCurrentTime()`, `getDuration()`, `timeupdate` event                                                                                                                                                       |
| end of video                  | `onStateChange` with `ENDED` (0)                                                                                                                                                   | `ended` event (not with `loop`)                                                                                                                                                                               |
| title                         | none documented for the current video                                                                                                                                              | `getVideoTitle()`                                                                                                                                                                                             |

- **The speed ladder (ADR 0015) fits.** 0.75, 1, 1.25, 1.5 and 2 are within both players' ranges.
  ADR 0015 already treats an answered rate as the truth, and the protocol's `rateChanged` maps onto
  `onPlaybackRateChange` and `playbackratechange`. A YouTube video whose rate list is only `[1]`, or
  a Vimeo video without `speed`, gives a ladder that never moves. That degrades the speed keys and
  needs a message.
- **Keyboard commands work while focus is in the code.** FollowAlong's keys are VS Code keybindings
  that send `PlayerCommand`s (ADR 0003). The player page would turn each one into an API call on the
  embedded player, so the protocol does not change. Auto-pause (ADR 0052, 0090) is a core `pause`
  and `play` and works the same way.
- **The first play from a key is refused, as today (ADR 0008).** The webview's content frame is
  given `allow="autoplay"` by VS Code ([webviewElement.ts][vsc-element], [pre/index.html][vsc-pre]).
  The nested player frame needs `allow="autoplay"` too, because a cross-origin frame gets autoplay
  only by delegation ([Chrome autoplay policy][cr-autoplay], [Permissions Policy][cr-pp]). With User
  Activation v2, a click inside a frame activates the frames that contain it, not the frames inside
  it ([user activation][cr-ua]). So the learner's click must land in the YouTube or Vimeo frame
  itself. Whether a later key-driven `playVideo()` then plays is **unknown** (the same open
  question as ADR 0008).
- **Focus inside the platform's frame is a Focus change.** VS Code forwards `keydown` to the
  workbench only from the webview's own window and content frame, never from frames nested inside
  ([pre/index.html][vsc-pre]). Simple Browser shows a "Focus Lock" badge for exactly this case
  ([simpleBrowserView.ts][sb-view]). While the YouTube or Vimeo frame has focus, every FollowAlong
  and VS Code keybinding is dead.
- **Focus return (ADR 0009) only half works.** No `pointerup`, `keyup` or media events reach the
  page from a cross-origin frame. The page can see that the frame took focus (`blur` on its window,
  or `document.activeElement` being the iframe, as Simple Browser polls it), and the player's state
  events (play, pause, rate) arrive through the API. Return focus on those. A seek-bar drag inside
  the frame cannot be seen, so focus could come back mid-drag; a short grace period is the best
  available. The transparent click overlay of ADR 0009 cannot stay over the picture (see question
  5).

## 3. What degrades

| Feature                                                            | Verdict                     | Why                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Progress and resume (ADR 0010, 0016)                               | **works**                   | Position and duration come from the API (poll on YouTube); resume is a seek. Lesson identity becomes a URL or video ID, which is the map's question, not this one.                                                                                                                        |
| Done rules (ADR 0030), next overlay (ADR 0019)                     | **works**                   | Driven by position, duration and the end event.                                                                                                                                                                                                                                           |
| Zoom to a dragged area (ADR 0037, 0087, 0088)                      | **breaks** (by the terms)   | Zoom is a CSS transform on a frame, so it needs no pixels and would scale an iframe. But it crops the player and its controls, and the drag box is an overlay in front of the player. Both are against YouTube's rules on modifying and obscuring the player and Vimeo §3.4 (question 5). |
| MP4 audio sidecar (ADR 0034), audio cache (ADR 0096)               | **not applicable**          | No local file. Splitting out or swapping audio is prohibited by the YouTube Developer Policies ([policies][yt-policies]). Whatever codec the platform streams either plays or does not (question 1).                                                                                      |
| Video spots, mini strip, floating window (ADR 0049, 0100, 0102)    | **works, with the D3 cost** | They are the same webview in another group or window. Each move makes a new page, which reloads the embed, seeks, and may land paused as ADR 0008/D3 already says. YouTube's 200×200 minimum viewport (question 5) may rule out a very short mini strip.                                  |
| Collapse (ADR 0092)                                                | **works**                   | It drops the page, so nothing plays unseen.                                                                                                                                                                                                                                               |
| A player tab hidden behind another tab (`retainContextWhenHidden`) | **degrades**                | YouTube prohibits playback from a player not shown on screen ([policies][yt-policies]). The player must pause when its panel is hidden.                                                                                                                                                   |
| Hiding the native speed menu (ADR 0009)                            | **breaks** (by the terms)   | Blocking any part of the platform's player is not allowed.                                                                                                                                                                                                                                |

## 4. Titles and playlists

- **YouTube without a key:** the IFrame API loads a playlist (`listType: 'playlist'`, `list`) and
  `getPlaylist()` returns its **video IDs** in order, with no titles ([reference][yt-api]). The
  oEmbed endpoint (`https://www.youtube.com/oembed?url=…&format=json`) returns `title`,
  `author_name` and a thumbnail for one video without a key, following the [oEmbed spec][oembed].
  No Google page documents it, so the evidence is third-party (low trust). Titles would then be one
  oEmbed call per video, after the playlist has loaded in a player.
- **YouTube with a key:** Data API `playlistItems.list` returns IDs and titles, up to 50 per page,
  for 1 quota unit a call out of a default 10,000 a day ([playlistItems.list][yt-pli],
  [quota][yt-quota]). It needs a Google Cloud project and an API key. Each user brings a key, or
  FollowAlong ships one and must then follow the full Developer Policies as an API client.
- **Vimeo:** `getVideoTitle()` in the SDK and oEmbed give one video's title without a token
  ([README][vimeo-readme], [oEmbed overview][vimeo-oembed]). Listing a showcase's videos goes
  through the authenticated Vimeo API (an app and a token). Vimeo's help mentions oEmbed for
  showcases, but the page could not be read: **unknown**.

## 5. Terms of service

**YouTube** ([RMF][yt-rmf], [Developer Policies][yt-policies], [compliance guide][yt-guide]):

- The viewport must be at least **200×200 px**, and 480×270 is recommended for 16:9.
- **No overlays, frames or other visual elements in front of any part of the player**, controls
  included. The compliance guide allows overlays that get consent or give playback controls, as long
  as they do not conflict with the YouTube UI.
- **Do not modify, build upon or block any part of the player** beyond what the API documents.
  `controls=0` and `disablekb=1` are documented parameters, but hiding the speed menu or other UI is
  not.
- **Identify yourself with the HTTP Referer** (question 1). This is the hard requirement.
- **No playback from a player that is not shown on screen.** **No separating or modifying the
  audio or video.** Autoplay only once the player is more than half visible, with one autoplaying
  player at a time.
- Ads are left alone (no blocking or changing the player). A desktop editor extension is not
  excluded as an API client, and the rules above apply to it as to any app.

**Vimeo** ([Developer Addendum][vimeo-addendum], [Terms][vimeo-terms]): "you may not modify,
obscure, or interfere with any element of our embeddable video player" unless the Services allow it
or Vimeo agrees in writing. No ads around playback without approval, and Vimeo's marks only as the
Brand Guidelines allow. Logo and control visibility are the **owner's** plan settings, not the
embedder's.

**So controlling playback through the documented API is allowed on both platforms. Drawing on,
cropping or scaling the player is not.**

## 6. Failure

- **YouTube `onError`** ([reference][yt-api]): `2` invalid parameter (a bad video ID); `5` HTML5
  player error; `100` not found (removed or private); `101`/`150` the owner does not allow embedded
  playback; `153` no Referer or client identification. No code is documented for network loss: the
  player sits in `BUFFERING` (3). No code is documented for region locks either (**unknown**,
  likely a player message or 100/101).
- **Vimeo** ([README][vimeo-readme], [player errors][vimeo-errors]): an `error` event with `name`
  and `message`. Method promises reject with `PrivacyError` (privacy or domain-limited),
  `PasswordError` (password-protected; unlisted videos need the `h` hash in the URL), `RangeError`,
  or a generic `Error`. Buffering is reported through `bufferstart`/`bufferend`. Network loss and
  region locks have no documented error: **unknown**.
- Every failure maps onto the existing `error {lessonId, message}` event (ADR 0003). The player
  page needs a watchdog for "loaded but never ready" (offline before the API script arrives), as ADR
  0056 does for sound.

## Summary

| Question                | Verdict                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Embedding            | **Vimeo: works** for publicly embeddable videos (needs `frame-src`). **YouTube: breaks** from a `vscode-webview://` page (no Referer, error 153). It needs an https relay page FollowAlong hosts, whose acceptability under the "store app ID" rule is unknown. Domain-limited Vimeo videos break. Vimeo audio in VS Code's codec set is unknown. |
| 2. Control              | **Works** for play, pause, seek, position, duration and end on both. Speed works within the ladder but depends on the video (YouTube rate list, Vimeo `speed`). Keys work while focus is in the code. Focus inside the frame is a Focus change, and focus return only half works.                                                                 |
| 3. What degrades        | Progress, resume, done, next and video spots work. Zoom breaks (terms). The sidecar and audio cache do not apply. A hidden tab must pause. Hiding player UI is not allowed.                                                                                                                                                                       |
| 4. Titles and playlists | Video IDs without a key (YouTube `getPlaylist`). Titles one at a time through oEmbed (undocumented by Google) or Vimeo `getVideoTitle`. A whole list with titles in one call needs the YouTube Data API with a key, or a Vimeo token.                                                                                                             |
| 5. Terms                | Allowed when the API is used as documented. It requires the Referer identification, at least 200×200, no overlays or cropping, no hidden playback, and no audio separation. Vimeo forbids modifying or obscuring the player.                                                                                                                      |
| 6. Failure              | YouTube reports 2/5/100/101/150/153. Vimeo reports named errors. Neither reports network loss or region locks clearly (unknown). Needs a load watchdog.                                                                                                                                                                                           |

[sb-view]: https://github.com/microsoft/vscode/blob/main/extensions/simple-browser/src/simpleBrowserView.ts
[vsc-pre]: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/index.html
[vsc-element]: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/webviewElement.ts
[vsc-env]: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/environment/electron-browser/environmentService.ts
[cr-policy]: https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/weborigin/security_policy.cc
[cr-schemes]: https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/weborigin/scheme_registry.cc
[el-content]: https://github.com/electron/electron/blob/main/shell/app/electron_content_client.cc
[cr-autoplay]: https://developer.chrome.com/blog/autoplay
[cr-pp]: https://developer.chrome.com/docs/privacy-security/permissions-policy
[cr-ua]: https://developer.chrome.com/blog/user-activation
[cr-ext-153]: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/OUJad0q-d_g
[rnw-153]: https://github.com/react-native-webview/react-native-webview/discussions/3855
[yt-api]: https://developers.google.com/youtube/iframe_api_reference
[yt-params]: https://developers.google.com/youtube/player_parameters
[yt-rmf]: https://developers.google.com/youtube/terms/required-minimum-functionality
[yt-policies]: https://developers.google.com/youtube/terms/developer-policies
[yt-guide]: https://developers.google.com/youtube/terms/developer-policies-guide
[yt-help]: https://support.google.com/youtube/answer/171780
[yt-help-pem]: https://support.google.com/youtube/answer/171780?expand=PrivacyEnhancedMode
[yt-pli]: https://developers.google.com/youtube/v3/docs/playlistItems/list
[yt-quota]: https://developers.google.com/youtube/v3/determine_quota_cost
[oembed]: https://oembed.com/
[vimeo-readme]: https://github.com/vimeo/player.js/blob/master/README.md
[vimeo-embed]: https://developer.vimeo.com/player/sdk/embed
[vimeo-speed]: https://help.vimeo.com/hc/en-us/articles/12426285015441-About-playback-speed-controls
[vimeo-cookies]: https://help.vimeo.com/hc/en-us/articles/26080940921361-Vimeo-Player-Cookies
[vimeo-ref]: https://help.vimeo.com/hc/en-us/articles/35817429341457-Troubleshooting-video-playback-errors-due-to-referrer-policy-conflicts
[vimeo-errors]: https://help.vimeo.com/hc/en-us/articles/12425812280081-Troubleshoot-player-error-messages
[vimeo-oembed]: https://help.vimeo.com/hc/en-us/articles/12427952430481-Overview-oEmbed
[vimeo-addendum]: https://vimeo.com/legal/service-terms/api
[vimeo-terms]: https://vimeo.com/legal
[opera-aac]: https://forums.opera.com/topic/89324/opera-doesn-t-support-aac-in-mp4-containers/1
