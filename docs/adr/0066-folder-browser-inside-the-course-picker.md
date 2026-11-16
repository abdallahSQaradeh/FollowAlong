# The Folder browser: Browse… drills down inside the Course picker

#39 adds _Browse…_ to the Course picker (spec #12, stories 14 and 15), so the learner can open
something outside their Courses roots, or something the scan missed. The spec calls it "a
drill-down inside the quick pick". These are the choices it leaves open.

## One quick pick, updated in place

- **It reuses the live Course picker** (ADR 0058), it does not open a new quick pick per folder.
  Walking down ten folders would otherwise close and reopen the quick pick ten times, losing
  its place, and the scan of the Courses roots (ADR 0058) would have to be joined each time.
  `showCoursePicker` keeps a `browsing` view; the quick pick shows the Folder browser's list
  (`src/core/folder-browser.ts`, a pure model) instead of the list of Courses until the learner
  goes _Back to Courses_. A scan that lands while the learner browses does not replace what they
  see (the view is chosen at each redraw).
- **Items that keep the quick pick open.** `QuickPickItemModel.keepsOpen` marks an item whose
  pick does not answer the quick pick: the adapter tells the core, as it does for a title bar button,
  and the core replaces the list. The `UiSink.openPicker` callback is renamed `onStayOpen`, since it
  now serves both. A _folder_, _Up_, _Back to Courses_ and _Browse…_ keep it open; a video and an
  _Open as Course_ close it with an intent.
- **A different title is a different list.** The adapter keeps what the learner typed, the highlighted
  item and the scroll position when the core replaces a list under the same title (a Refresh, a
  busy indicator). When the title changes (every folder has its own: `Browse: <folder>`) the text is
  cleared and the list starts at the top, because both belonged to the list that is gone.
- **_Browse…_ is an item, not a title bar button.** The learner opens the picker with `Ctrl+'` `C` and
  should be able to reach it by keyboard (story 18); title bar buttons cannot be reached with keys.
  It sits above _Add Courses root…_ and keeps the quick pick open.

## Where it starts, and how to go up

- **At the Courses roots**, each labelled with its folder name and its path (two roots can share a
  name). With **no root** it starts at the drives (Windows) or the home folder (elsewhere), through a
  new File system port call, `startingFolders()`. The node adapter lists `A:\`–`Z:\` that answer a
  `stat` within 1.5 s (a gone network drive must not hold the browser up) and `os.homedir()` elsewhere. The Seam 1
  harness fakes it (`setStartingFolders`), since a test machine's own drives are no fixture.
- **With roots, the drives or home folder are listed too**, under an _Elsewhere_ separator below the
  roots. The spec says the browser starts at the roots, and also that its purpose is to reach what is
  outside them: with the roots alone the learner on `D:\Learning` could never reach `C:\Users\…`.
- **_Up_** goes to the folder's parent, also above a Courses root. Above the root of a drive (or `/`) it
  goes to the top of the browser. The first row of every folder is _Up_; the first row of the top is
  _Back to Courses_.

## What it lists

- **Subfolders, then videos, each in natural order.** Subfolders are those the scan walks
  (`isWalked`: no hidden folder, no `node_modules`, none of the folders Windows keeps at a drive
  root). Of the files only Lessons (`.mp4`, `.webm`) are listed; other files are left out.
  A folder with no video, and a zip-only folder, is still a folder: the learner may need to walk
  through it.
- **"Holds videos" means directly.** A folder shows _Open as Course_ when it holds a Lesson file
  itself, which is what makes a folder a Course for the scan (ADR 0022). A folder whose videos are all
  in subfolders does not: the learner walks into the Sections' parent, or opens a subfolder. Looking
  below would read whole branches of a large drive for every row.
- **Looked at after the list is shown.** The folders are listed at once, with the quick pick busy;
  one read of each tells which hold videos, and the buttons appear when all are known. A folder
  that cannot be read counts as one that holds none, silently; opening it tells the learner.
- **_Open as Course_** is a button beside the folder (it closes the quick pick and opens the folder
  as a Course, the same intent as picking a Course). Inside a folder that holds videos the same
  action is also the first item, _Open “X” as Course_, because an item can be picked with the keys.
  Roots and drives that hold videos get the button too.

## What picking does

- **A video** answers `playVideo { folder, video }`. `open` takes the video as an option: the folder
  opens as the Course through the same path as any Course (Recent, Resources, Progress, player
  roots), and the Lesson that is that video plays as `playLesson` plays one (from 5 s before its saved
  position, with autoplay), not the Course's last Lesson or the first (story 15). There is no
  parallel open path.
- **A video of the Course that is open** plays through `playLesson` without opening the Course
  again; **_Open as Course_ on the open Course** changes nothing that plays (ADR 0041).
- **A Course outside the roots** gets its folder added to the player's folders (ADR 0022, D9), so
  the page reloads once; that is accepted. The Course is remembered in Recent as any other.
- **An unreadable folder** is a warning (“FollowAlong can't read the folder “X”.”) and a log line;
  the quick pick stays on the list the learner picked it from.

## Not done here

Hiding a stray folder (#38), the Progress line (#36) and _Open in new window_ (#40). The File system
port still has no way to cancel a read, so a slow folder read finishes in the background when the
learner has gone on or closed the picker; its result is dropped.
