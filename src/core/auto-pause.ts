/**
 * Auto-pause while typing (spec #12, stories 98–105; ADR 0052). A pure state machine, fed by the
 * learner's edits, what the player reports, and the setting; it answers with the new state and what
 * to do. The Loaded Lesson feeds it and carries out what it answers.
 */
import { isAbsolute, relative } from 'node:path';

import { courseDataFolderName } from './course-data.js';
import { keyOf } from './courses-roots.js';
import type { Config } from './ports.js';

/** The `followalong.autoPause` setting. */
export type AutoPauseMode = 'off' | 'pause' | 'pauseAndResume';

/** The setting as the learner has it; anything else (unset, a hand-edited typo) is `off`. */
export function readAutoPauseMode(config: Pick<Config, 'get'>): AutoPauseMode {
  const value = config.get('autoPause');
  return value === 'pause' || value === 'pauseAndResume' ? value : 'off';
}

/**
 * - `off`: the setting is off.
 * - `armed`: an edit while the Lesson plays pauses it.
 * - `autoPaused`: an edit paused the Lesson, and it has not played since.
 */
export type AutoPauseState = 'off' | 'armed' | 'autoPaused';

export type AutoPauseInput =
  /** The setting changed, or is read for the first time. */
  | { readonly type: 'modeChanged'; readonly mode: AutoPauseMode }
  /** The learner edited the active editor's document; `playing`: the Lesson is playing. */
  | { readonly type: 'typed'; readonly playing: boolean };

/** What the Loaded Lesson does for a step: `pause` sends the player `pause`. */
export type AutoPauseEffect = 'pause';

export interface AutoPauseStep {
  readonly state: AutoPauseState;
  readonly effects: readonly AutoPauseEffect[];
}

export function stepAutoPause(state: AutoPauseState, input: AutoPauseInput): AutoPauseStep {
  switch (input.type) {
    case 'modeChanged':
      return {
        state: input.mode === 'off' ? 'off' : state === 'off' ? 'armed' : state,
        effects: [],
      };
    case 'typed':
      return state === 'armed' && input.playing
        ? { state: 'autoPaused', effects: ['pause'] }
        : { state, effects: [] };
  }
}

/** A change to the text of a document open in VS Code, as the adapter forwards it. */
export interface DocumentEdit {
  /** The document's URI scheme: `file`, `untitled`, `output`, `vscode-userdata`, … */
  readonly scheme: string;
  /** The absolute path of a `file` document; none for the others. */
  readonly path?: string;
  /** Whether the document is the one in the active editor. */
  readonly inActiveEditor: boolean;
}

/**
 * Whether `edit` is the learner typing in the Practice area: a file or untitled document, in the
 * active editor. Output panels, the Source Control box and the settings are other schemes.
 * FollowAlong's own edits never count (ADR 0052): it never types into an editor, but it writes its
 * Course data to disk, which VS Code reloads into a copy the learner has open and reports as an
 * edit. So a file in a `.followalong` folder, or in the extension's `storageFolder`, is not typing.
 */
export function isTyping(edit: DocumentEdit, storageFolder: string): boolean {
  if (!edit.inActiveEditor) {
    return false;
  }
  if (edit.scheme === 'untitled') {
    return true;
  }
  return (
    edit.scheme === 'file' &&
    edit.path !== undefined &&
    !isFollowAlongData(edit.path, storageFolder)
  );
}

/** Whether `path` is a file FollowAlong writes: Course data, or anything in its own storage. */
function isFollowAlongData(path: string, storageFolder: string): boolean {
  const file = keyOf(path);
  if (file.split(/[\\/]/).includes(keyOf(courseDataFolderName))) {
    return true;
  }
  const inside = relative(keyOf(storageFolder), file);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}
