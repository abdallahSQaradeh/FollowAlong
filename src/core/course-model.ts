/**
 * The Course model (spec #12, Core modules → Course model): a pure function from a folder
 * listing to the Course's Lessons and Sections. It never touches the file system.
 */
import { extname } from 'node:path';

export type Container = 'mp4' | 'webm';

/** What the model reads of a folder: its file names and its subfolders. */
export interface FolderListing {
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
  readonly files: readonly string[];
  readonly folders: readonly FolderListing[];
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

function outlineOf(listing: FolderListing, idPrefix: string): Outline {
  const lessons = listing.files
    .flatMap((file): Lesson[] => {
      const container = containerOf(file);
      return container === undefined
        ? []
        : [
            {
              id: `${idPrefix}${file}`,
              path: `${listing.path}/${file}`,
              title: file.slice(0, file.length - extname(file).length),
              container,
            },
          ];
    })
    .sort((a, b) => naturalOrder(a.id, b.id));
  const sections = [...listing.folders]
    .sort((a, b) => naturalOrder(a.name, b.name))
    .flatMap((folder): Section[] => {
      const id = `${idPrefix}${folder.name}/`;
      const inside = outlineOf(folder, id);
      return inside.lessons.length === 0 && inside.sections.length === 0
        ? []
        : [{ id, name: folder.name, ...inside }];
    });
  return { lessons, sections };
}

export function buildCourse(listing: FolderListing): Course {
  return { folder: listing.path, ...outlineOf(listing, '') };
}

/** Every Lesson of the Course in play order: a folder's own Lessons, then its Sections'. */
export function lessonsInOrder(outline: Outline): Lesson[] {
  return [...outline.lessons, ...outline.sections.flatMap(lessonsInOrder)];
}
