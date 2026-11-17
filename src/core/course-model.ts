/**
 * The Course model (spec #12, Core modules → Course model): a pure function from a folder
 * listing to the Course's Lessons and Sections. It never touches the file system.
 */
import { extname, join } from 'node:path';

import type { Container } from '../protocol/player-messages.js';
import { cleanFileName, titlesFromLists } from './lesson-titles.js';

/** What the model reads of a folder: its file names and its subfolders. */
export interface FolderListing {
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
  readonly files: readonly string[];
  readonly folders: readonly FolderListing[];
  /**
   * The text of the `.txt` files the model may take for the Course's title list, by file name:
   * only the Course folder and its wrapper folders are read.
   */
  readonly textFiles?: Readonly<Record<string, string>>;
}

export interface Lesson {
  /** The Lesson's path in the Course, with `/` separators: stable and unique. */
  readonly id: string;
  /** Absolute path. */
  readonly path: string;
  readonly title: string;
  readonly container: Container;
}

/** Lessons and Sections in the order the Course presents them: Lessons first, then Sections. */
export interface Outline {
  readonly lessons: readonly Lesson[];
  readonly sections: readonly Section[];
}

export interface Section extends Outline {
  /** The Section folder's path in the Course, with `/` separators and a trailing `/`. */
  readonly id: string;
  readonly name: string;
}

export interface Course extends Outline {
  /** Absolute path of the Course folder. */
  readonly folder: string;
}

/** Whether the file is a Lesson: an `.mp4` or `.webm`, in any letter case. */
export function isLessonFile(fileName: string): boolean {
  return containerOf(fileName) !== undefined;
}

function containerOf(fileName: string): Container | undefined {
  switch (extname(fileName).toLowerCase()) {
    case '.mp4':
      return 'mp4';
    case '.webm':
      return 'webm';
    default:
      return undefined;
  }
}

/** "lesson2" before "lesson10"; a fixed locale, so the order does not depend on the machine. */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function naturalOrder(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Folders that never hold Lessons: FollowAlong's own `.followalong` and every other hidden
 * folder (`.git`), and `node_modules`.
 */
export function isSkippedFolder(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/**
 * A wrapper folder holds no Lessons and exactly one Section: it collapses into that Section's
 * content, and keeps its own (outermost) name.
 */
function withoutWrappers({ lessons, sections }: Outline): Outline {
  const [only, ...others] = sections;
  return lessons.length === 0 && only !== undefined && others.length === 0
    ? withoutWrappers(only)
    : { lessons, sections };
}

function outlineOf(
  listing: FolderListing,
  idPrefix: string,
  courseNames: readonly string[],
): Outline {
  const lessons = listing.files
    .flatMap((file): Lesson[] => {
      const container = containerOf(file);
      return container === undefined
        ? []
        : [
            {
              id: `${idPrefix}${file}`,
              path: join(listing.path, file),
              title: cleanFileName(file, courseNames),
              container,
            },
          ];
    })
    .sort((a, b) => naturalOrder(a.id, b.id));
  const sections = listing.folders
    .filter((folder) => !isSkippedFolder(folder.name))
    .sort((a, b) => naturalOrder(a.name, b.name))
    .flatMap((folder): Section[] => {
      const id = `${idPrefix}${folder.name}/`;
      const inside = outlineOf(folder, id, courseNames);
      return inside.lessons.length === 0 && inside.sections.length === 0
        ? []
        : [{ id, name: folder.name, ...withoutWrappers(inside) }];
    });
  return { lessons, sections };
}

/**
 * The `.txt` files that can be the Course's title list, in natural order of their names: those
 * of the Course folder and of the wrapper folders collapsed into it, outermost first.
 */
function titleListTexts(listing: FolderListing): string[] {
  const own = Object.entries(listing.textFiles ?? {})
    .sort(([a], [b]) => naturalOrder(a, b))
    .map(([, text]) => text);
  const [only, ...others] = listing.folders
    .filter((folder) => !isSkippedFolder(folder.name))
    .filter(holdsLessons);
  return !listing.files.some(isLessonFile) && only !== undefined && others.length === 0
    ? [...own, ...titleListTexts(only)]
    : own;
}

/** Whether the folder holds a Lesson at any depth (hidden folders and `node_modules` aside). */
function holdsLessons(listing: FolderListing): boolean {
  return (
    listing.files.some(isLessonFile) ||
    listing.folders.some((folder) => !isSkippedFolder(folder.name) && holdsLessons(folder))
  );
}

function withTitles({ lessons, sections }: Outline, titles: ReadonlyMap<string, string>): Outline {
  return {
    lessons: lessons.map((lesson) => ({ ...lesson, title: titles.get(lesson.id) ?? lesson.title })),
    sections: sections.map((section) => ({ ...section, ...withTitles(section, titles) })),
  };
}

/**
 * The Course in `listing`. `courseNames` are the names a Lesson file name may end in as
 * ` _ <name>`: always {@link courseNames} in `courses-roots.ts`, through `readCourse`, so every
 * place that shows titles drops the same names (ADR 0085).
 */
export function buildCourse(listing: FolderListing, courseNames: readonly string[]): Course {
  const outline = withoutWrappers(outlineOf(listing, '', courseNames));
  const lessons = lessonsInOrder(outline);
  const listed = titlesFromLists(titleListTexts(listing), lessons.length);
  const titled =
    listed === undefined
      ? outline
      : withTitles(
          outline,
          new Map(lessons.map((lesson, index) => [lesson.id, listed[index] ?? lesson.title])),
        );
  return { folder: listing.path, ...titled };
}

/** Every Lesson of the Course in play order: a folder's own Lessons, then its Sections'. */
export function lessonsInOrder(outline: Outline): Lesson[] {
  return [...outline.lessons, ...outline.sections.flatMap(lessonsInOrder)];
}

/** The Section with this id (its folder's path in the Course), at any depth, or `undefined`. */
export function findSection(outline: Outline, sectionId: string): Section | undefined {
  for (const section of outline.sections) {
    const found = section.id === sectionId ? section : findSection(section, sectionId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
