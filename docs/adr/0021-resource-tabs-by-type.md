# A Resource opens by its file type: previews for HTML and Markdown, a bundled pdf.js viewer for PDF

Spec #12 (story 94) says a Resource opens "in a VS Code tab beside the code while the video keeps
playing: code and text in the editor, HTML, Markdown and images in a preview, PDFs in a FollowAlong
viewer". ADR 0012 gave the opener one kind of target (`file`) and said later tickets add kinds and
route them inside the adapter. These are the choices the spec leaves open.

## The core chooses the kind, the adapter draws it

- `resourceTarget(path)` in `src/core/resources.ts` maps the file's extension, without regard to
  case, to the kind the `UiSink.openResource` target carries (no new port, ADR 0002):

  | Extension                                                         | Kind       | Opens as                              |
  | ----------------------------------------------------------------- | ---------- | ------------------------------------- |
  | `.md`, `.markdown`                                                | `markdown` | FollowAlong preview                   |
  | `.html`, `.htm`                                                   | `html`     | FollowAlong preview                   |
  | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`, `.avif` | `image`    | VS Code's image preview               |
  | `.pdf`                                                            | `pdf`      | FollowAlong PDF viewer                |
  | anything else, and no extension                                   | `file`     | the editor, as before (text and code) |

  A name that only ends like a type (`pdf`, `.md`: no extension in Node's sense) is a `file`.
  **SVG stays a `file`**: it is XML a learner reads and edits as code, so it opens in the editor.
  Seam 1 tests the choice per type.

- The kind decides only which adapter code runs. Every kind opens in the group `placement.column()`
  names (ADR 0012, orchestrator decision D4): never the player's group, `preserveFocus`. The
  placement now also counts FollowAlong's own Resource tabs and image previews as "a group that
  holds a Resource", so a PDF and a text file collect in one group.
- **Images** go through `vscode.open`, so VS Code's own image preview shows them; the editor
  association the learner has configured still applies.

## HTML and Markdown: one preview tab, scripts off

VS Code's Markdown preview commands (`markdown.showPreview`, `…ToSide`) cannot be aimed at an editor
group, which would put the preview in the player's group (D4). So FollowAlong draws the preview
itself in a webview tab (`followalong.preview`), in the group the placement names:

- **Scripts never run.** The webview is created with `enableScripts: false`, the page says
  `script-src 'none'`, and an HTML file is shown in an `<iframe sandbox="" srcdoc>` (no
  `allow-scripts`, no `allow-same-origin`). The learner's page cannot read the tab around it,
  cannot reach the extension, and runs nothing. Seam 2 checks all three
  (`test/player/resource-preview.spec.ts`; the blocked scripts are expected, so those tests open
  their own page instead of the console-echoing fixture and assert on the blocks).
- **Local files still load.** `localResourceRoots` is the file's own folder, and a `<base>` pointing
  at it (as a webview URI) makes the page's relative styles, images and fonts resolve. Remote
  images are not allowed (`img-src` is the webview origin and `data:`): a preview that is just a
  file in the learner's Course should not call out.
- **Markdown is rendered by VS Code**: `markdown.api.render` (the built-in Markdown extension), put
  in the tab with the editor's fonts and colours. If that extension is off, the file opens as text
  instead of failing, with a warning in the log.
- A file that changes on disk is not re-rendered; open the Resource again (it brings the tab
  forward but does not reload it). Live reload is not in this ticket.

## PDF: a bundled pdf.js viewer

Electron's webviews have no PDF viewer, so FollowAlong bundles one. Source: orchestrator approval
for the dependency (over 1 MB, Apache-2.0), with these conditions, all met:

- **`pdfjs-dist@6.5.438`, a pinned `devDependency`, bundled by esbuild** (ADR 0004) into
  `out/pdf/pdf-viewer.js` (the viewer) and `out/pdf/pdf.worker.js` (the pdf.js worker), minified in
  the `.vsix`: 0.44 MB and 1.16 MB. **Measured with `npm run package`: the `.vsix` goes from
  19.8 KB (integration/v1 at `89f28cd`) to 543.7 KB, +524 KB compressed (+1.6 MB unpacked).** Nothing is loaded from the
  network, and `node_modules` stays out of the package.
- **Hardening.** pdf.js 6.5 has no `isEvalSupported` option and no `eval`/`new Function` in its
  build (checked in the sources shipped), and the page's policy has no `'unsafe-eval'`, so the
  CVE-2024-4367 class (a crafted font reaching `eval`) has nothing to reach. The viewer reads
  pages only: no scripting layer is loaded (a PDF's JavaScript never runs), no annotation layer
  (**a link in a PDF is inert; nothing navigates the webview and nothing is handed to the
  browser**), no text layer, and `enableXfa: false`. No `cMapUrl`, `standardFontDataUrl` or
  `wasmUrl` is given, so nothing outside the page is fetched for fonts or decoders; the cost is
  that a PDF that needs a non-embedded CJK font or a JPEG 2000 / JBIG2 image may draw those
  parts badly. Reading text out of the PDF (select, search) is not there either.
- **Policy.** `default-src 'none'`; `script-src` and `style-src` allow only the page's nonce;
  `connect-src` the webview origin (the PDF itself); `worker-src blob:` (the worker's source is
  inlined in the page, as the player's script is, ADR 0004, and started from a `blob:` URL);
  `img-src` and `font-src` `blob:` and `data:` (what pdf.js makes). **`localResourceRoots` is
  the PDF's own folder and nothing else**: the extension's `out/` folder is not a root, because
  the scripts are in the page.
- **The viewer reports to the extension** with two events (`src/protocol/pdf-viewer-messages.ts`):
  `rendered {pages}` once page 1 is drawn, and `failed {message}`. The test hooks (ADR 0002)
  expose them so the smoke test can see that a fixture PDF drew. The page itself shows "This PDF
  can't be shown" with the reason when a file is not a PDF.
- **What the viewer does**: draws pages lazily as they near the screen, zooms (− / ＋ / Fit width,
  25 % to 500 %), shows the current page number. Its Seam 2 test
  (`test/player/pdf-viewer.spec.ts`) loads the built page in Chromium with a generated 3-page
  fixture (`scripts/make-pdf-fixture.mjs`) and checks the pages drawn and their text ink, zoom,
  the not-a-PDF message, and that nothing is fetched from outside the page's origin.
- **Licence.** pdf.js is Apache-2.0. Its notice and the licence text are in
  `THIRD_PARTY_NOTICES.txt`, which is listed in the package's `files`. The ffmpeg LGPL notice of the
  sidecar ticket goes in the same file.

## Considered options

- **Chromium's own PDF viewer in an `<iframe>`/`<embed>`.** Rejected: the PDF plugin is off in
  Electron webviews.
- **`markdown.showPreviewToSide` for Markdown.** Rejected: it opens in the active group's
  neighbour, which can be the player's group (D4), and takes no group argument.
- **A Markdown renderer of our own (a dependency).** Rejected: VS Code already ships one, and
  `markdown.api.render` is a stable command.
- **Letting the learner's HTML run scripts.** Rejected for this ticket: a preview of a file from a
  downloaded Course should not run code in the extension's webview. A learner who needs the page
  live can open it from the Course folder in a browser.
- **Reading the worker from `out/pdf/` through a webview URI.** Rejected: the cross-origin
  `Worker` would need a `blob:` wrapper anyway, and a second `localResourceRoot` for the
  extension's own files.
- **Passing the PDF's bytes through `postMessage`** so no folder is a root at all. Rejected for now:
  a large book would be copied into memory twice, where a fetch by the worker can use Range
  requests. Revisit if the folder root proves too wide.

## Consequences

- `package.json` `files` lists the two PDF scripts and the notices file; `scripts/build.mjs` builds
  them (and fails on warnings, like the other bundles).
- A PDF tab and a preview tab are created per file and reused when the same Resource opens again.
  They are not restored when VS Code restarts (no webview serializer), like the player.
- Link clicks inside a PDF, text selection and search are not in this ticket. Seam 2 opens a PDF
  that is a link all over and runs JavaScript on open (`test/fixtures/pdf/active.pdf`) and checks
  that nothing happens: no dialog, no navigation, no request. It guards against a later ticket
  adding an annotation or scripting layer without thinking about this.
- Pages not drawn yet are sized like page 1, so a PDF with mixed page sizes shifts a little as its
  pages are drawn.
- Opening a Resource that already has a tab brings the tab forward **in the group the placement
  names**, so a tab the learner dragged into the player's group goes back out of it (D4).
- The smoke test opens a Markdown, an HTML, an image and a PDF Resource and checks the kind of tab
  each gets and that the PDF viewer drew page 1; it runs in CI only, because VS Code cannot be
  downloaded in the cloud session that built this.
