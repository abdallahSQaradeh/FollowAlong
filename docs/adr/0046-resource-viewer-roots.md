# The PDF viewer may read only its own file; the preview keeps its folder

ADR 0021 gave both Resource viewers `dirname(path)` as their `localResourceRoots` and said to
revisit it if it proved too wide. #56 (from CP1) asked for a decision. A Resource can be any file on
disk, so “the folder” can be a learner's whole Downloads or home folder: a viewer there can read
every file in it through the webview.

- **PDF viewer: the file itself.** The viewer fetches one thing, the PDF; its script and worker are
  inlined in the page (ADR 0004). `localResourceRoots` is now the PDF's own URI, not its folder.
  VS Code allows a request when the resource equals or is inside a root, so one file is a valid
  root. Nothing else beside the PDF can be read. The smoke test, which opens a PDF Resource and
  waits for page 1 to draw, is the check that VS Code accepts it.
- **HTML and Markdown preview: the folder stays.** A page refers to its sibling files by relative
  path (`./img/a.png`, `style.css`), and the `<base>` href points at the folder so they load
  (ADR 0021). A narrower root would break exactly the learner's own pages. The preview has scripts
  off, a policy that allows only the webview origin and `data:` images, and no network, so the
  folder is read-only to a page the learner chose to open. A Course's folder is the common case;
  a Resource outside the Course is something the learner attached on purpose.
- **Not chosen: bytes over `postMessage`.** Still rejected as in ADR 0021 (a large PDF copied twice).

## Consequences

- A PDF's own links or relative references to other files (none are followed, ADR 0021) have no root.
