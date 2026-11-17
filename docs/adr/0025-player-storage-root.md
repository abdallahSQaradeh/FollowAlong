# The player reads `<storage>/courses`, not the whole extension storage

ADR 0022 gave the player the Courses roots, the Course folder when it is outside them, and the
whole extension storage folder. At CP1 the player reads nothing from storage: its only file is
the Lesson (`resourceUri(lesson.path)`), and the Resource viewers have their own roots (the
Resource's folder, ADR 0021). The one planned reader is prepared sound (#41–#43). It lives in
Course data, whose fallback copy is `<storage>/courses/<name>-<hash>/` (ADR 0005).

- **Decision:** the player's last root is `<storage>/courses` (`fallbackRoot` in `course-data.ts`).
  The rest of the extension storage is no longer readable from the page. It is the same folder for
  every Course, so a Course switch under the Courses roots still keeps the page and its click
  (#12 D3, D9).
- **Rejected: the open Course's own fallback folder.** It is the narrowest root, but it changes on
  every Course switch. A changed root reloads the page and loses the click that lets it start
  playback (ADR 0022, measured in VS Code 1.146), so every switch would need a click again.

This revises the roots in ADR 0022, which listed the whole extension storage. Decided at CP1 with
the orchestrator (#12 agenda item 2).
