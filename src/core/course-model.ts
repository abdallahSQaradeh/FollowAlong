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

export interface Course {
  /** Absolute path of the Course folder. */
  readonly folder: string;
  readonly lessons: readonly Lesson[];
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

export function buildCourse(listing: FolderListing): Course {
  const lessons: Lesson[] = [];
  for (const file of listing.files) {
    const container = containerOf(file);
    if (container !== undefined) {
      lessons.push({
        id: file,
        path: `${listing.path}/${file}`,
        title: file.slice(0, file.length - extname(file).length),
        container,
      });
    }
  }
  return { folder: listing.path, lessons };
}
