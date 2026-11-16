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

/**
 * A Lesson file name read as a title: without the extension, the leading number, a `Lesson N -`
 * prefix and a trailing ` _ <Course name>`. A name that would be left empty keeps its stem.
 */
export function cleanFileName(fileName: string, courseName: string): string {
  const stem = fileName.slice(0, fileName.length - extname(fileName).length).trim();
  const suffix = ` _ ${courseName}`.toLowerCase();
  const withoutCourse = stem.toLowerCase().endsWith(suffix)
    ? stem.slice(0, stem.length - suffix.length)
    : stem;
  const cleaned = withoutCourse.replace(LEADING_NUMBER, '').replace(LESSON_PREFIX, '').trim();
  return cleaned === '' ? stem : cleaned;
}
