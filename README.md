# FollowAlong

A VS Code extension that plays a local coding Course beside your own code, so following a Lesson
never needs a Focus change. The spec is GitHub issue #12.

## Install

`npm ci && npm run package` writes `followalong-win32-x64-<version>.vsix`. Install it with
**Extensions: Install from VSIX…** or `code --install-extension <file>.vsix`.

The `.vsix` ships a minimal LGPL ffmpeg (`bin/ffmpeg.exe`, Windows x64), so MP4 Lessons have sound with
nothing else to install. `npm run package` needs it in `bin/` (git-ignored) and stops with a message
when it is not there. Get it one of two ways:

- Download the **ffmpeg-win32-x64** artifact of a CI run (the `ffmpeg` job) into `bin/`.
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

## Develop

Read `AGENTS.md` and `CODING_STANDARDS.md` first. `npm run build` bundles the extension into
`out/`; `npm run verify` runs every gate.
