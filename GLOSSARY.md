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

**Wrapper folder**:
A folder inside a Course that holds no Lessons of its own and only one other folder with Lessons. It is not shown as a Section: its content is shown in its place.
_Avoid_: Container folder, parent folder

**Title list**:
A `.txt` file in the Course folder (or a wrapper folder around its Lessons) with one line per Lesson, giving the instructor's real Lesson titles in Lesson order.
_Avoid_: Index, table of contents, names file

**Progress**:
How far the learner has got through a Course: each Lesson is not started, in progress (with the position they left it at), or done.
_Avoid_: History, completion

**Resource**:
A file or link the learner attaches to a Lesson or a Course, to keep beside it while following along. It is a reference to the file, never a copy.
_Avoid_: Material, attachment

**Course data**:
What FollowAlong keeps about a Course for itself (its Progress, its Resources, prepared sound), stored with the Course and never mixed into the Course's own files.
_Avoid_: Metadata, cache, settings

**Practice area**:
Where the learner types and runs code while following a Lesson.
_Avoid_: Sandbox, playground, workspace

**Follow-along loop**:
The repeated cycle of watch → pause → type → run → rewind that the learner performs throughout a Lesson.
_Avoid_: Workflow, session

**Step**:
One keypress that moves the playhead back or forward by a fixed number of seconds: the short step (5 s by default) or the long step (30 s by default). Both sizes are settings.
_Avoid_: Skip, jump, scrub

**Speed ladder**:
The fixed rungs the playback rate moves through, one keypress per rung: 0.75×, 1×, 1.25×, 1.5×, 2×. It stops at both ends.
_Avoid_: Speed slider, rate list

**One-press key**:
A FollowAlong key that is a single keypress, not a `Ctrl+'` chord: play/pause, and the short step back and forward. The integrated terminal sends it to the shell unless the learner has VS Code keep it. A chord works in the terminal as it is.
_Avoid_: Hotkey, shortcut, single key

**Loaded Lesson**:
The Lesson the player holds: it is set when the learner picks a Lesson or opens a Course, and gone when the learner closes the player. Controls that only make sense with a Lesson, such as the status bar items, show only while one is loaded.
_Avoid_: Active Lesson, current video

**Focus change**:
Any moment the learner must move their attention or input focus out of the Practice area to control the Course. The thing FollowAlong exists to eliminate.
_Avoid_: Context switch, tab switch, window switch
