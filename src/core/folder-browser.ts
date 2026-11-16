/**
 * The Folder browser (spec #12, Core modules → Folder browser model; ADR 0066): a pure function
 * from where the learner is, and what is there, to the quick pick behind “Browse…” in the Course
 * picker. Picking returns an intent; the core carries it out.
 */
import { dirname } from 'node:path';

import { folderLabel } from './course-scanner.js';
import type { QuickPickEntry, QuickPickModel } from './quick-pick.js';

/** What picking an item, or pressing a button, of the Folder browser asks the core to do. */
export type FolderBrowserIntent =
  /** Shows what is in `folder`; `undefined` is the top of the browser: the roots, or drives/home. */
  | { readonly type: 'browseTo'; readonly folder: string | undefined }
  /** Leaves the Folder browser for the Course picker's list of Courses. */
  | { readonly type: 'backToCourses' }
  /** Opens `folder` as the Course (Open as Course). */
  | { readonly type: 'openCourse'; readonly folder: string }
  /** Plays a video: its folder opens as the Course, and this video is the Lesson that plays. */
  | { readonly type: 'playVideo'; readonly folder: string; readonly video: string };

type Entry = QuickPickEntry<FolderBrowserIntent>;

/** A folder the browser lists. */
export interface BrowsedFolder {
  /** The folder's own name (a drive's root has none). */
  readonly name?: string;
  /** Absolute path. */
  readonly path: string;
  /**
   * Whether the folder directly holds a video, so it can be opened as a Course. `undefined` until
   * it has been looked at: it is then not offered yet.
   */
  readonly holdsVideos?: boolean;
}

/** A video the browser lists. */
export interface BrowsedVideo {
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
}

/** Where the learner is in the browser, and what is there. */
export type FolderBrowserView =
  | {
      /** The top: the Courses roots the learner named. */
      readonly kind: 'top';
      readonly roots: readonly BrowsedFolder[];
    }
  | {
      /** Inside `folder`: its subfolders, then its videos, in the order to show them. */
      readonly kind: 'folder';
      readonly folder: string;
      readonly folders: readonly BrowsedFolder[];
      readonly videos: readonly BrowsedVideo[];
    };

/** The folder above `folder`, or `undefined` (the top of the browser) above a drive or `/`. */
function parentOf(folder: string): string | undefined {
  const parent = dirname(folder);
  return parent === folder ? undefined : parent;
}

function folderItem(folder: BrowsedFolder, withPath: boolean): Entry {
  return {
    kind: 'item',
    label: folder.name ?? folderLabel(folder.path),
    ...(withPath ? { description: folder.path } : {}),
    intent: { type: 'browseTo', folder: folder.path },
    keepsOpen: true,
    ...(folder.holdsVideos === true
      ? {
          buttons: [
            {
              label: 'Open as Course',
              icon: 'play-circle',
              intent: { type: 'openCourse', folder: folder.path },
            },
          ],
        }
      : {}),
  };
}

export function buildFolderBrowser(view: FolderBrowserView): QuickPickModel<FolderBrowserIntent> {
  if (view.kind === 'top') {
    return {
      title: 'Browse folders',
      placeholder: 'Pick a folder to look inside it',
      matchOnDescription: true,
      entries: [
        {
          kind: 'item',
          label: 'Back to Courses',
          intent: { type: 'backToCourses' },
          keepsOpen: true,
        },
        // A root's name alone can be the same for two roots: the path tells them apart.
        ...view.roots.map((root) => folderItem(root, true)),
      ],
    };
  }
  const parent = parentOf(view.folder);
  return {
    title: `Browse: ${view.folder}`,
    placeholder: 'Pick a folder to look inside it, or a video to play it',
    matchOnDescription: false,
    entries: [
      {
        kind: 'item',
        label: 'Up',
        ...(parent === undefined ? {} : { description: parent }),
        intent: { type: 'browseTo', folder: parent },
        keepsOpen: true,
      },
      // Also for the folder itself: a key can pick this, and a button beside a row it cannot press.
      ...(view.videos.length === 0
        ? []
        : [
            {
              kind: 'item',
              label: `Open “${folderLabel(view.folder)}” as Course`,
              intent: { type: 'openCourse', folder: view.folder },
            } as const,
          ]),
      ...view.folders.map((folder) => folderItem(folder, false)),
      ...view.videos.map((video): Entry => ({
        kind: 'item',
        label: video.name,
        intent: { type: 'playVideo', folder: view.folder, video: video.path },
      })),
    ],
  };
}
