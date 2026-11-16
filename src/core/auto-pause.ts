/**
 * Auto-pause while typing (spec #12, stories 98–105; ADR 0052). A pure state machine, fed by the
 * learner's edits, what the player reports, and the setting; it answers with the new state and what
 * to do. The Loaded Lesson feeds it and carries out what it answers.
 */
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
