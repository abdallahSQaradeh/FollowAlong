# URL Resources: a second kind of reference, checked when attached and again when opened

Spec #12 (stories 90 and 94) lets the learner attach a URL as a Resource, and #55 builds it. A URL is
untrusted text: the learner types it, and `resources.json` is a file on disk that a downloaded
Course, a sync tool or another program could have written. These are the choices the spec leaves open.

- **Only `http:` and `https:`.** `checkWebUrl` (in `resources.ts`) parses the text with `new URL()`
  and accepts only those two schemes. `file:`, `command:`, `vscode:`, `vscode-remote:`,
  `javascript:`, `data:`, `ftp:`, `mailto:` and anything else is refused, with a message that names
  the scheme and says that only `http://` and `https://` can be attached. Text that does not parse
  (`example.com`, `not a url`) gets a message asking for a full address. The core never adds a
  scheme for the learner: guessing `https://` could send a typo to the wrong site, and the box
  shows the problem as they type. A URL is stored in the form `new URL` gives (`href`), without the
  spaces around it. `command:` is refused above all: Simple Browser would not run it, but any
  other opener could.
- **Checked twice.** The attach box (`TextPrompt.validate`) shows the problem while the learner
  types, and the core checks the confirmed text again, so an adapter that skips validation attaches
  nothing. `openResource` checks the stored address again before anything opens: a hostile
  `resources.json` can hold any text under `kind: "url"`. A stored URL that fails the check is not
  opened; the learner is told it cannot be opened and to Detach it. It still shows in the tree, so it
  can be detached. The address is never passed to a shell: it goes to VS Code's own command as a
  `Uri` (ADR 0048).
- **A record has a `kind`.** `ResourceRecord` is `FileResourceRecord | UrlResourceRecord`
  (`{ id, kind: 'url', url }`). The format stays version 1: a file with only file Resources reads
  and writes as before, and a URL record is an addition that an older FollowAlong would drop as
  malformed (it drops any Resource it cannot read, ADR 0040). The Resource tree node gets
  `type: 'file' | 'url'`; for a URL its `label` is the address without the scheme
  (`developer.mozilla.org/en-US/docs/Web/JavaScript`) and its `path` is the address.
- **One attach path.** The Lesson "+", the chord and the Course "+" all reach `attachTo` (ADR 0045),
  which now opens a choice first, **File…** or **URL…** (`attachChoice`, a quick pick through
  `UiSink.pick`), then the file dialog or `UiSink.askText`. A file given up front (no choice) skips it.
  The chord keeps its focus return (ADR 0023) for the URL box too. Closing the choice or the box
  attaches nothing.
- **Detach works; Relink and “missing” do not apply.** A URL has no file to lose: it is never
  missing and never dimmed, `missingResources` skips it, the tree item offers Detach but not
  Relink…, and `relinkResource` on a URL says so and changes nothing.
- **Reuse, not a new store.** `ResourceStore` gains `attachUrl` and `attachUrlToCourse`, the same
  change as `attach`, so ordering, re-read, merge, refusal and the fallback copy (ADR 0040) apply.

## Consequences

- A Resource's reference is now either a path or an address; code that needs a path (`resourcePath`,
  `relink`) takes `FileResourceRecord`, so the compiler shows every place a URL needs a decision.
- Attaching asks one more question than before (File… or URL…). The learner who attaches many files
  pays one extra keypress each; if that proves a nuisance, remember the last choice, in a later ticket.
