# Hiding a stray folder from the Course picker, and getting it back

#38 keeps the Course picker to real Courses (spec #12, story 10): _Hide_ on a Course entry removes a
stray folder, such as a `code\…\images` folder holding one video. It extends the Course picker
model and the live picker (ADR 0058, 0068). These are the choices the spec leaves open; the
orchestrator accepted them for #38.

## The hidden-Course list

- **Where, and under what identity.** The global storage, key `hiddenCourses`, as a list of
  `{ folder, name }` (`src/core/hidden-courses.ts`). The folder is the Course folder, normalised
  with `normalisedRoot` and compared with `keyOf`: the identity the Course list cache (ADR 0058) and
  Recent (ADR 0041) use. The name is what the picker listed it under, kept so _Unhide_ can name the
  Course without a scan. Per machine, like Recent; not a `.followalong` file, so hiding never
  changes a Course folder (story 106).
- **It filters the display only.** The scan, the Course list cache and Recent storage stay as they
  were; `buildCoursePicker` drops a hidden folder from the picker. A rescan, Refresh or restart
  therefore cannot bring it back.
- **Damaged values are ignored**, entry by entry, never repaired: an entry without a full-path
  folder is skipped, one without a name is named by its folder.
- **Writing never fails the picker.** The entry leaves the open list at once; if the global storage
  refuses the write, one warning goes in the log and the Course is back at the next open.

## What Hide applies to

- **Every Course entry that is not missing**, in Recent and in the A–Z list. A missing Recent
  Course already has _Locate…_ and _Remove_ and is not a stray folder.
- **A hidden Recent Course is not listed in Recent either**, and **the open Course can be hidden**
  too; it stays open. Recent shows at most 5 (ADR 0041) and keeps only 5, so there is nothing
  beyond them to fill the gap with: Recent shows fewer than 5 while some are hidden. The A–Z list
  has no gap: the Course is not listed there either.
- **The picker stays open** and updates in place, as Refresh does (the live picker's `update`).

## The item button that stays open

`QuickPickButtonModel` gains `staysOpen`. CP2 renamed it `keepsOpen` and moved it to
`QuickPickItemButtonModel`, through the `KeepsOpen` that item buttons share with items (the flag of
ADR 0066), since both mean the same; title bar buttons have none. An item button used to close the quick pick and answer with
its intent (_Locate…_, _Remove_). With `staysOpen` it does what a title bar button does: the core is
told through the callback `openPicker` already has and may replace the model. It is generic, so
other item buttons that keep the picker open (#40, Open in new window) reuse it.

## Undoing a hide

- **`FollowAlong: Unhide a Course…`**, a Command Palette command with no keybinding and no chord
  letter (story 46: every control is a `FollowAlong: …` command). It lists the hidden Courses
  (name, folder) in a quick pick; picking one takes only that one off the list and says so in one
  info message. With nothing hidden it says "No Courses are hidden."
- **Considered: clear the whole list.** Rejected: after one mistaken hide it would bring every other
  stray folder back.
- **Considered: no undo in v1.** Rejected: the list is in global storage, which the learner cannot
  edit, so a mistake would be permanent.
- A Course unhidden is listed again at once from the cache, and read again by the next scan.

## Consequences

- A hidden Course still opens by every other way (the Open Course command with a folder, a restored
  window, Recent in another window's list); only the picker's listing is filtered.
- A folder the learner hides and later deletes stays in the list, where _Unhide_ shows it.
- Hide and _Unhide_ are not written down anywhere in a Course folder, so on another machine the
  stray folder shows again until it is hidden there.
