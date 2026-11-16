# FollowAlong

Learning a coding course by following the instructor step by step, without ever leaving the place where you write and run code.

## Language

**Course**:
A downloaded folder of Lessons.
_Avoid_: Bootcamp, class, tutorial

**Courses root**:
A folder the learner names as holding their Courses, possibly nested inside category folders.
_Avoid_: Library, collection

**Lesson**:
One video inside a Course.
_Avoid_: Episode, clip, lecture

**Course picker**:
The quick pick behind _Open Course…_ (`Ctrl+'` `C`) that lists the Courses found under the Courses roots, so the learner can open one by typing, or add a Courses root. It opens at once from the **Course list cache**, shows a busy indicator while it rescans, and has a _Refresh_ button that rescans straight away.
_Avoid_: Course list, library view

**Course list cache**:
The Courses the last scan of the Courses roots found, kept on this machine (not in any Course folder) so the Course picker can open from it before the rescan is done. It is used only for the same Courses roots, and a copy that cannot be read is ignored.
_Avoid_: Course data, library index, scan results

**Section**:
A named group of Lessons within a Course, in the order the Course presents them.
_Avoid_: Module, chapter, part

**Lesson picker**:
The quick pick that lists the open Course's Lessons grouped by Section, so the learner can jump to any Lesson by typing.
_Avoid_: Lesson search, jump list

**Course order**:
The order the Course presents its Lessons in: a folder's own Lessons first, then its Sections, each in natural order. The next and previous Lesson, and the Lesson tree, follow it. It stops at the first and the last Lesson and does not wrap.
_Avoid_: Playlist order, queue

**Next overlay**:
The "Next: <title>" button the player shows over the last frame when a Lesson ends and another follows. Clicking it loads that Lesson; nothing moves on without the click. The last Lesson of a Course has none.
_Avoid_: Autoplay next, up next, end card

**Lesson tree**:
The FollowAlong view in the activity bar: the open Course's Sections and Lessons in Course order, each Lesson with its state (✓ done, ◐ in progress, ○ not started) and, when in progress, its position and length (`12:30 / 40:05`); each Section with its done/total (`3/12`); and the Course's done/total and percent (`27/140 · 19%`) beside the Course's name at the top. The Lesson the learner is on is highlighted and revealed.
_Avoid_: Course library view, outline, playlist

**Wrapper folder**:
A folder that holds no Lessons of its own and only one other folder with Lessons. Inside a Course it is not shown as a Section: its content is shown in its place. Around a Course it gives the Course its name, the outermost wrapper winning.
_Avoid_: Container folder, parent folder

**Category folder**:
A folder under a Courses root that groups several Courses and is not one itself. Its path is shown beside each Course in the Course picker, and typing matches it.
_Avoid_: Genre, topic folder, group

**Known Course**:
A folder that holds FollowAlong's own `.followalong` folder, or is one of the Recent Courses, and has a Lesson somewhere below it: it counts as a Course even when its Lessons are only in subfolders.
_Avoid_: Opened Course, tracked Course

**Recent Courses**:
The Courses the learner opened last (5 at most, newest first), kept on this machine and listed first in the Course picker. The Course open in this window is tagged _(open)_. One whose folder has moved shows as _missing_, with _Locate…_ to point it at its new folder and _Remove_ to drop it.
_Avoid_: History, favourites, last opened

**Title list**:
A `.txt` file in the Course folder (or a wrapper folder around its Lessons) with one line per Lesson, giving the instructor's real Lesson titles in Lesson order.
_Avoid_: Index, table of contents, names file

**Progress**:
How far the learner has got through a Course: each Lesson is not started, in progress (with the position they left it at), or done. A Lesson is in progress after 10 s of play, and done when its playhead reaches the last 5 % or the end. Done stays until the learner un-marks it, and a done Lesson saved in its last 5 % starts again at 0:00.
_Avoid_: History, completion

**Progress line**:
The second line of a Course in the Course picker that has Progress: `27/140 · 19% · last: <Lesson title>` (Lessons done of all Lessons, percent rounded down as in the Lesson tree, and the title of the Lesson played last). A Course nobody played, or whose Progress was reset, has none; a last Lesson that is unknown or reset leaves out `last:`.
_Avoid_: Status line, summary

**Reset**:
To take away a Lesson's done mark and saved position, so it reads as never played. Offered for a Section's Lessons (_Reset Section_) and for the whole Course (_Reset Course progress_, after a confirmation; the Course then reopens on its first Lesson). It never touches Resources or prepared sound. _Mark all done_ on a Section is its counterpart for that Section: every Lesson in it is marked done, each keeping its saved position. For one Lesson, _Mark done_ and _Mark not done_ (the tree's Lesson menu) and the `Ctrl+'` `D` toggle (which does one or the other, by the Lesson's state) work on one Lesson: "not done" is a reset of that Lesson.
_Avoid_: Clear, wipe, restart

**Resource**:
A file or link the learner attaches to a Lesson or a Course, to keep beside it while following along. It is a reference to the file, never a copy.
_Avoid_: Material, attachment

**URL Resource**:
A Resource that is the address of a web page (`http` or `https` only), attached with “URL…” next to “File…”. It opens in Simple Browser beside the code. It has no file, so it is never missing and cannot be relinked; it can be detached.
_Avoid_: Link, bookmark

**Course Resource**:
A Resource attached to the whole Course, such as a cheat sheet, with the "+" on the Course node at the top of the Lesson tree. It shows above the Sections and opens like a Lesson's Resource.
_Avoid_: Global Resource, shared Resource

**Detach**:
To take a Resource off a Lesson or a Course. Only the reference goes; the file stays where it is.
_Avoid_: Delete, remove

**Missing Resource**:
A Resource whose file is no longer where it points, because the learner moved, renamed or deleted it. It shows dimmed in the tree until it is relinked or detached.
_Avoid_: Broken link, dead Resource

**Relink**:
To point a Resource at another file, keeping it where it is in its Lesson. Offered on a missing Resource.
_Avoid_: Re-attach, repair

**Resource tab**:
The tab a Resource opens in, beside the code and never in the player's group, so the video stays in sight. The kind of tab follows the file's type: the editor for text and code, VS Code's image preview for images, a FollowAlong preview for HTML and Markdown, the FollowAlong PDF viewer for PDFs, and Simple Browser for a URL Resource.
_Avoid_: Attachment view, Resource panel

**Course data**:
What FollowAlong keeps about a Course for itself (its Progress, its Resources, prepared sound), stored with the Course and never mixed into the Course's own files.
_Avoid_: Metadata, cache, settings

**Audio sidecar**:
An MP4 Lesson's sound, converted to MP3 and kept in Course data, that plays beside the video because VS Code cannot play the Lesson's own sound. The video leads, and the sidecar follows its play, pause, seeks and speed.
_Avoid_: Soundtrack, audio copy, audio cache

**Sound notice**:
The words over the first frame of an MP4 Lesson that waits for its Audio sidecar: "Preparing sound… N%" while the sound is converted (the status bar says the same), or the error and the _Play without sound_ button when preparing failed. The Lesson starts by itself when the sound is ready, or when the learner presses play if that is later.
_Avoid_: Loading screen, spinner, splash

**Play without sound**:
The button on the error of a failed Sound notice. It plays the picture alone, and nothing else plays the Lesson until it is pressed, so the learner is never stuck and never left with a silent Lesson they did not choose.
_Avoid_: Skip sound, mute, continue anyway

**Practice area**:
Where the learner types and runs code while following a Lesson.
_Avoid_: Sandbox, playground, workspace

**Follow-along loop**:
The repeated cycle of watch → pause → type → run → rewind that the learner performs throughout a Lesson.
_Avoid_: Workflow, session

**Step**:
One keypress that moves the playhead back or forward by a fixed number of seconds: the short step (5 s by default) or the long step (30 s by default). Both sizes are settings.
_Avoid_: Skip, jump, scrub

**Rewind**:
The seconds the video jumps back when the learner resumes a paused Lesson by hand, so they rehear the last words (the `resumeRewind` setting, 0 by default). Automatic resumes never rewind.
_Avoid_: Replay, back-up

**Auto-pause**:
An opt-in mode in which the learner's typing in the active editor pauses a playing Lesson; the play/pause status bar item shows a keyboard while it is on, and "Paused (typing)" while the pause it caused holds. Only the learner's own edits count: never cursor moves, other panels, or FollowAlong's own changes.
_Avoid_: Typing detection, smart pause, auto-stop

**Speed ladder**:
The fixed rungs the playback rate moves through, one keypress per rung: 0.75×, 1×, 1.25×, 1.5×, 2×. It stops at both ends.
_Avoid_: Speed slider, rate list

**One-press key**:
A FollowAlong key that is a single keypress, not a `Ctrl+'` chord: play/pause, and the short step back and forward. The integrated terminal sends it to the shell unless the learner has VS Code keep it. A chord works in the terminal as it is.
_Avoid_: Hotkey, shortcut, single key

**Loaded Lesson**:
The Lesson the player holds: it is set when the learner picks a Lesson or opens a Course, and gone when the learner closes the player. Controls that only make sense with a Lesson, such as the status bar items, show only while one is loaded.
_Avoid_: Active Lesson, current video

**Video spot**:
Where the player sits in the VS Code window: an editor group beside the code (the default), the bottom panel or the secondary sidebar. The learner moves the video from one spot to another without losing its place.
_Avoid_: Location, dock, layout, position

**Zoom**:
Showing an area of the Lesson's picture enlarged to fill the player, so the learner can read the instructor's code. It belongs to the player, not to a Lesson: it stays while the Lesson plays and when the next one loads, until the learner resets it.
_Avoid_: Magnify, crop, close-up

**Focus change**:
Any moment the learner must move their attention or input focus out of the Practice area to control the Course. The thing FollowAlong exists to eliminate.
_Avoid_: Context switch, tab switch, window switch

**Focus return**:
Handing keyboard focus back to the editor or terminal the learner used last, once they finish an interaction with the player, so that controlling the Course with the mouse is not a Focus change.
_Avoid_: Focus restore, refocus
