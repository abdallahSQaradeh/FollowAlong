# Map: FollowAlong v1

Label: wayfinder:map

## Destination

A buildable v1 spec for FollowAlong: a VS Code extension that plays a locally downloaded coding Course inside VS Code, so the whole Follow-along loop happens in one window with no Focus change. Done when nothing is left to decide before a build session starts.

## Notes

- Domain: see `D:\Projects\FollowAlong\GLOSSARY.md`. Use its terms.
- Learner: one screen (usually a laptop, sometimes 27"). Switching is painful at any screen size, so the problem is Focus change, not screen space.
- Learner uses **mouse and keyboard**. Every control must work both ways without leaving the Practice area.
- Practice area = VS Code (the learner's daily editor).
- Courses live in `D:\Learning\Courses` (and siblings): mostly `.mp4` (~325) and `.webm` (~114) videos, usually with a `code.zip` per Course.
- Skills to consult each session: `grilling`, `domain-modeling`.
- Tracker: local markdown (`issues/NN-<slug>.md`, `Type:` / `Status:` / `Blocked by:` lines).

## Decisions so far

- Pain to solve: the whole Follow-along loop, not one step of it.
- Shape: one app, one window, Course and Practice area together. AI-made transcripts and snippets are a later add-on.
- Scope of v1: coding Courses only, downloaded locally.
- Platform: a VS Code extension.
- Controls: hotkeys and in-editor mouse controls, so the learner never leaves VS Code.
- Video playback: webview plays H.264 video but not AAC audio (all Course MP4s are AAC), and WebM only via MediaSource. Player stays in the webview; how MP4 sound gets fixed is open in [Fixing MP4 sound](issues/05-fixing-mp4-sound.md). See [research/01-video-playback.md](research/01-video-playback.md).

## Not yet specified

- Getting code out of the video: copying code the instructor shows on screen (OCR? the Course's `code.zip` mapped to Lessons?).
- Progress: where the learner left off in each Lesson, and which Lessons are done.
- Notes and bookmarks tied to timestamps in a Lesson.
- How `code.zip` becomes a Practice area (unzip into a workspace? per Lesson starting points?).

## Out of scope

- Non-coding Courses (marketing, trading, English, …): need a different Practice area. A future effort with its own map.
- AI transcripts and step-by-step notebooks generated from Lessons: a later add-on on top of v1, not part of v1.
- Streaming or DRM platforms (Udemy, Coursera web, YouTube): v1 handles local files only.
