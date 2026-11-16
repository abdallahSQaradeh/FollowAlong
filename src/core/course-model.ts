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

function naturalOrder(a: string, b: string): number {
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

function outlineOf(listing: FolderListing, idPrefix: string, courseName: string): Outline {
  const lessons = listing.files
    .flatMap((file): Lesson[] => {
      const container = containerOf(file);
      return container === undefined
        ? []
        : [
            {
              id: `${idPrefix}${file}`,
              path: join(listing.path, file),
              title: cleanFileName(file, courseName),
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
      const inside = outlineOf(folder, id, courseName);
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
    .filter((folder) => holdsLessons(outlineOf(folder, '', folder.name)));
  return !listing.files.some(isLessonFile) && only !== undefined && others.length === 0
    ? [...own, ...titleListTexts(only)]
    : own;
}

function holdsLessons({ lessons, sections }: Outline): boolean {
  return lessons.length > 0 || sections.length > 0;
}

function withTitles({ lessons, sections }: Outline, titles: ReadonlyMap<string, string>): Outline {
  return {
    lessons: lessons.map((lesson) => ({ ...lesson, title: titles.get(lesson.id) ?? lesson.title })),
    sections: sections.map((section) => ({ ...section, ...withTitles(section, titles) })),
  };
}

export function buildCourse(listing: FolderListing): Course {
  const outline = withoutWrappers(outlineOf(listing, '', listing.name));
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
