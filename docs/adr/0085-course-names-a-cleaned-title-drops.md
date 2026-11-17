# The Course names a cleaned Lesson title drops

A Lesson's file name loses a trailing ` _ <Course name>` when it becomes a title (ADR 0014). Until
CP2 the Course name was only the name of the folder that was opened. Since #34 the Course picker
names a Course after its outermost wrapper folder (ADR 0032), and the scan opens the folder that
holds the Lessons. So `Learning/Docker Mastery/docker-mastery-2024/01 Intro _ Docker Mastery.mp4`
kept ` _ Docker Mastery` in its title (CP2 agenda a, routed from PR #85).

_Source: the orchestrator's answer to CP2 agenda a on #12 (option 1, with conditions). It is
binding._

- **Which names.**
  - The Course folder's own name.
  - The name of every folder between the Course folder and the first Courses root that holds it.
    That is the order the scan files a Course in (ADR 0022). The outermost wrapper is always one of
    them.
  - Never the Courses root's own name.
  - A Course under no root has only its own name. So does one whose first root (in the setting's
    order) that is it or holds it is the Course folder itself. When an outer root comes first, the
    wrappers' names count, as the scan then names the Course after them.
  - `courseNames(folder, roots)` in `courses-roots.ts` is the one place this is worked out, from the
    path alone, with no reads of the parent folders.
- **How a name is matched.** Exactly as before: ` _ <name>` at the end of the name without its
  extension, without regard to letter case. Only the set of names grew.
- **At most one suffix goes.** When two fit, the longer goes. A title that would be left empty keeps
  the name without its extension, as before.
- **A title list still wins** over cleaned file names (ADR 0014).
- **One reader, the same names everywhere.** `readCourse(ports, folder, roots)` in
  `folder-listing.ts` reads every Course that shows titles. That is:
  - the open, so a Course opened from the picker, from Recent, by a workspace restore or by the
    Course hand-off gets the same titles, and so do the Lesson tree and the Lesson picker built
    from it;
  - the Progress lines;
  - Locate….

## Considered options

- **Only real wrappers' names**, found by reading each parent folder up to the root and applying the
  scan's wrapper rule. Rejected:
  - every open would read more of the disk;
  - the scan's wrapper rule would exist twice, once in the open path.
- **Leaving it**, and letting Manual QA judge on real downloads. Rejected by the orchestrator.

## Consequences

- **Accepted over-strip:** a title that ends in ` _ <category folder name>` loses it, because a
  category folder lies between the Course and its root (`Web/React Basics/01 Intro _ Web.mp4` reads
  `Intro`). A Seam 1 test states this in its name.
- A Courses root added or removed changes which names apply. A Course already open keeps its titles
  until it is opened again.
- Manual QA (#64): read titles on real downloads under wrapper folders.
