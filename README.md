# FollowAlong

A VS Code extension that plays a local coding Course beside your own code, so following a Lesson
never needs a Focus change. The spec is GitHub issue #12.

## Install

`npm ci && npm run package` writes `followalong-win32-x64-<version>.vsix`. Install it with
**Extensions: Install from VSIX…** or `code --install-extension <file>.vsix`.

The `.vsix` ships a minimal LGPL ffmpeg (`bin/ffmpeg.exe`, Windows x64), so MP4 Lessons have sound with
nothing else to install. `npm run package` needs it in `bin/` (git-ignored) and stops with a message
when it is not there. Get it one of two ways:

- `npm run fetch-ffmpeg` (Windows too): downloads the **ffmpeg-win32-x64** artifact of the newest
  successful CI run into `bin/` with the GitHub CLI (`gh auth login` first), then checks it. The
  extension run from the repository (F5) also takes ffmpeg from `bin/`, so run this once per clone.
- Or build it on Linux with mingw-w64: install the tools with
  `sudo apt-get install gcc-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64 make nasm xz-utils`,
  then run `node scripts/build-ffmpeg.mjs`. It downloads the pinned sources
  (`scripts/bundled-ffmpeg.json`, checked against their SHA-256) and writes `bin/`.
  `node scripts/check-bundled-ffmpeg.mjs` then runs the result, checks that it is LGPL and that it
  converts sound.

`followalong.ffmpegPath` (user settings) names another ffmpeg instead. On Linux and macOS, where the
`.vsix` is not built for, FollowAlong runs the `ffmpeg` on your PATH.

## Use

Run **FollowAlong: Open Course…** and pick a Course folder. Its first WebM Lesson plays in an editor
group beside your code. The folder you have open in VS Code stays your Practice area and is never changed.

Press `Ctrl+'` then `L` (or run **FollowAlong: Go to Lesson…**) to jump to any Lesson of the open Course.
The list is grouped by Section, and typing a Section name narrows it to that Section.

Press `Ctrl+'` then `V` (or run **FollowAlong: Toggle video**) to collapse the video and get space for
code. Press it again to bring the video back in the same spot, at the same place.

**FollowAlong: Move video to…** → _Mini strip above the code_ puts the video in a short group above
your code; drag its edge to resize it. It keeps its time, speed and zoom, like the other
spots. `followalong.videoLocation` set to `miniStrip` opens it there.

**FollowAlong: Move video to…** → _Floating window_ puts the video in a small window of its own that
stays on top of VS Code; resize it with its edges. It is never the default, because a click in it
moves the focus out of the main window. Closing that window closes the Lesson's player, as closing its
tab does; its Progress is saved, and the next Lesson opens where `followalong.videoLocation` says.

Press `Ctrl+'` then `A` (or run **FollowAlong: Toggle Auto-pause**) to switch auto-pause off, or back
on in the mode you used last (`pause` the first time). Press `Ctrl+'` then `R` (or run
**FollowAlong: Attach Resource**) to attach a file to the Lesson that plays.

## Develop

Read `AGENTS.md` and `CODING_STANDARDS.md` first. `npm run build` bundles the extension into
`out/`; `npm run verify` runs every gate.
