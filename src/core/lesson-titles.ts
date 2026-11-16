/**
 * Lesson titles (spec #12, Core modules → Course model): the instructor's real titles from a
 * `.txt` title list when its line count equals the Lesson count, and cleaned file names otherwise.
 * Pure: the title lists arrive as text.
 */
import { extname } from 'node:path';

/** `01 `, `02. `, `03 - `, `04_`: a number, then a separator. Not `3D` and not `1.5x`. */
const LEADING_NUMBER = /^\d+(?:\s*[-_.)]+\s*|\s+)(?!\d)/u;

/** `Lesson 3 - `, with a hyphen, en dash or em dash. */
const LESSON_PREFIX = /^Lesson\s+\d+\s*[-–—]\s*/iu;

/** `stem` without a trailing ` _ <name>`, compared without regard to letter case, if it ends in one. */
function withoutSuffix(stem: string, name: string): string | undefined {
  const suffix = ` _ ${name}`;
  const cut = stem.length - suffix.length;
  return cut > 0 && stem.slice(cut).toLowerCase() === suffix.toLowerCase()
    ? stem.slice(0, cut)
    : undefined;
}

/**
 * A Lesson file name read as a title: without the extension, the leading number, a `Lesson N -`
 * prefix and one trailing ` _ <Course name>`, where the Course name is any of `courseNames` (the
 * Course folder's and its wrappers', ADR 0085). Of two that fit, the longer goes. A name that would
 * be left empty keeps its stem.
 */
export function cleanFileName(fileName: string, courseNames: readonly string[]): string {
  const stem = fileName.slice(0, fileName.length - extname(fileName).length).trim();
  const withoutCourse =
    courseNames
      .map((name) => withoutSuffix(stem, name))
      .filter((cut) => cut !== undefined)
      .sort((a, b) => a.length - b.length)[0] ?? stem;
  const cleaned = withoutCourse.replace(LEADING_NUMBER, '').replace(LESSON_PREFIX, '').trim();
  return cleaned === '' ? stem : cleaned;
}

/** The lines of a title list: no byte order mark, trimmed, and without blank lines. */
function titleLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/u, '')
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The titles of the first title list (in the order given) with exactly `lessonCount` lines, or
 * `undefined` when none fits, so a notes file with another line count never blocks the real list.
 */
export function titlesFromLists(
  lists: readonly string[],
  lessonCount: number,
): string[] | undefined {
  return lists.map(titleLines).find((lines) => lines.length === lessonCount);
}
