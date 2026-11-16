/**
 * The Folder browser (spec #12, Core modules → Folder browser model; ADR 0066): a pure function
 * from where the learner is, and what is there, to the quick pick behind “Browse…” in the Course
 * picker. Picking returns an intent; the core carries it out.
 */
import { folderLabel } from './course-scanner.js';
import type { QuickPickEntry, QuickPickModel } from './quick-pick.js';

/** What picking an item, or pressing a button, of the Folder browser asks the core to do. */
export type FolderBrowserIntent =
  /** Shows what is in `folder`; `undefined` is the top of the browser: the roots, or drives/home. */
  | { readonly type: 'browseTo'; readonly folder: string | undefined }
  /** Leaves the Folder browser for the Course picker's list of Courses. */
  | { readonly type: 'backToCourses' };

type Entry = QuickPickEntry<FolderBrowserIntent>;

/** A folder the browser lists. */
export interface BrowsedFolder {
  /** Absolute path. */
  readonly path: string;
}

/** Where the learner is in the browser, and what is there. */
export interface FolderBrowserView {
  /** Where the browser starts: the Courses roots the learner named. */
  readonly roots: readonly BrowsedFolder[];
}

export function buildFolderBrowser(view: FolderBrowserView): QuickPickModel<FolderBrowserIntent> {
  const folders = view.roots.map((root): Entry => ({
    kind: 'item',
    label: folderLabel(root.path),
    description: root.path,
    intent: { type: 'browseTo', folder: root.path },
    keepsOpen: true,
  }));
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
      ...folders,
    ],
  };
}
