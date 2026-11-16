# FollowAlong

A VS Code extension that plays a local coding Course beside your own code, so following a Lesson
never needs a Focus change. The spec is GitHub issue #12.

## Install

`npm ci && npm run package` writes `followalong-win32-x64-<version>.vsix`. Install it with
**Extensions: Install from VSIX…** or `code --install-extension <file>.vsix`.

## Use

Run **FollowAlong: Open Course…** and pick a Course folder. Its first WebM Lesson plays in an editor
group beside your code. The folder you have open in VS Code stays your Practice area and is never changed.

Press `Ctrl+'` then `L` (or run **FollowAlong: Go to Lesson…**) to jump to any Lesson of the open Course.
The list is grouped by Section, and typing a Section name narrows it to that Section.

## Develop

Read `AGENTS.md` and `CODING_STANDARDS.md` first. `npm run build` bundles the extension into
`out/`; `npm run verify` runs every gate.
