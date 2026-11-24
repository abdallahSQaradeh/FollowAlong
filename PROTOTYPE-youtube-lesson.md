# PROTOTYPE: a YouTube Lesson in the player (throwaway, never merge)

Spike for the wayfinder ticket _How does a YouTube Lesson feel in the player?_ (map _Lessons from a
URL or an external video site_). Everything it adds is named `prototype-*` or marked `PROTOTYPE`.

## How it works

- A YouTube Lesson stands in as a text file `NN Title.youtube.webm` in an ordinary local Course,
  holding a YouTube URL. The core loads it like a WebM Lesson (no sidecar), so Progress, resume,
  the Lesson tree, auto-pause and every key work unchanged.
- The player panel turns that file into `youtube:<id>?relay=…`. The page hides the `<video>`, zoom
  and click overlay, and frames the **relay page** (`media/prototype-youtube-relay.html`), which
  embeds YouTube (youtube-nocookie) with the IFrame API. Player commands go in, state comes out,
  all with `postMessage`.
- The extension serves the relay on `http://127.0.0.1:<random port>/relay.html`, and `/echo`, which
  logs the Referer of whatever frames it.
- A grey strip at the top of the player shows the mode, YouTube's state, the playhead and the
  focus. It turns red when focus is stuck in the YouTube frame or the relay never answered.
- Everything measured goes to **Output → FollowAlong**, on lines starting `[prototype]`.

## Run it

```sh
git checkout <this branch> && npm ci && npm run build
npm run prototype:youtube-course -- ~/Courses/youtube-spike            # 3 sample videos
npm run prototype:youtube-course -- ~/Courses/youtube-spike <url> <url>  # or your own
code --extensionDevelopmentPath="$PWD" <some practice folder>
```

Then **FollowAlong: Open Course…** and pick the `youtube-spike` folder (or add `~/Courses` as a
Courses root).

Settings:

- `followalong.prototype.youtubeRelay`: `local` (default), `direct` (YouTube framed straight from
  the webview, no control), or the https URL of `prototype-youtube-relay.html` hosted anywhere.
- `followalong.prototype.youtubeFocusReturn`: `true` (default) hands focus back 0.8 s after it
  lands in the YouTube frame; `false` leaves it stranded.

## What to judge (bring the answers back to the ticket)

1. **Referer.** The `Referer measured, frame in webview` line (expected: none) and
   `frame in relay-local`, plus the relay's `document.referrer` line.
2. **Direct mode.** With `direct`, does YouTube show error 153?
3. **Local relay.** With `local`, does the relay load at all? A red `RELAY SILENT` strip means
   Chromium's Local Network Access checks (or something else) blocked `127.0.0.1`: this happened
   in headless Chromium from an https page. If it loads, does YouTube play with a
   `http://127.0.0.1:<port>/` Referer, or give 153?
4. **Hosted relay** (only if the local relay fails): put the relay HTML on an https static host,
   set its URL, and repeat 3.
5. **First play.** Does the play key work before any click? After one click inside YouTube?
6. **Keys.** Play/pause, short and long steps, the speed ladder (does YouTube round any rate?).
7. **Auto-pause while typing**, and the resume after it.
8. **Ads, overlays, the end screen's suggested videos**, and the Next overlay on top of them.
9. **Focus.** Click inside YouTube (its seek bar, its gear menu). How bad is the dead-key moment
   with the return off? With it on, does the 0.8 s return rescue it, or cut a seek-bar drag short?
10. **Spots.** The floating window and mini strip (YouTube wants at least 200×200), the bottom
    panel: does a move keep the position and the play state?
11. **Progress.** Leave a Lesson part way, reopen it: does it resume (with rewind)?
