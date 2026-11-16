# Both Resource viewers keep the file's folder as their root

ADR 0021 gave both Resource viewers `dirname(path)` as their `localResourceRoots` and said to
revisit it if it proved too wide. #56 (from CP1) asked for a decision. A Resource can be any file on
disk, so “the folder” can be a learner's whole Downloads or home folder: a viewer there can read
every file in it through the webview.

- **Tried: the PDF file itself as the PDF viewer's only root.** The viewer fetches one thing, the
  PDF, so this looked enough. The smoke test on Windows (CI, #89) showed otherwise: the viewer never
  drew page 1 ("Timed out … waiting for the PDF viewer drawing the first page"). VS Code does not
  serve a webview file whose root is a file URI, at least on Windows, so the root went back to the
  folder.
- **PDF viewer: the folder stays.** Its script and worker are inlined (ADR 0004), so the folder is
  read only for the PDF, which a script of ours fetches; nothing else is fetched (Seam 2 checks
  that nothing outside the page's origin is requested).
- **HTML and Markdown preview: the folder stays.** A page refers to its sibling files by relative
  path (`./img/a.png`, `style.css`), and the `<base>` href points at the folder so they load
  (ADR 0021). A narrower root would break exactly the learner's own pages. The preview has scripts
  off, a policy that allows only the webview origin and `data:` images, and no network, so the
  folder is read-only to a page the learner chose to open.
- **Why that is acceptable.** A viewer can show only what its own page asks for, and its page is
  ours (PDF) or runs no script (preview). A Resource is a file the learner attached on purpose.
- **Not chosen: bytes over `postMessage`.** Still rejected as in ADR 0021 (a large PDF copied twice).
  It is the way to narrow the PDF viewer further if the folder proves too wide.

## Consequences

- No viewer code changes in #56. A PDF's own links or relative references to other files are not
  followed (ADR 0021).
