/**
 * Auto-pause while typing (spec #12, stories 98–105; ADR 0052). A pure state machine, fed by the
 * learner's edits, what the player reports, and the setting; it answers with the new state and what
 * to do. The Loaded Lesson feeds it and carries out what it answers.
 */
import { isCourseDataFile } from './course-data.js';
import type { Config } from './ports.js';

/** The `followalong.autoPause` setting. */
export type AutoPauseMode = 'off' | 'pause' | 'pauseAndResume';

/** The setting as the learner has it; anything else (unset, a hand-edited typo) is `off`. */
export function readAutoPauseMode(config: Pick<Config, 'get'>): AutoPauseMode {
  const value = config.get('autoPause');
  return value === 'pause' || value === 'pauseAndResume' ? value : 'off';
}

/** The quiet period setting of `pauseAndResume`, in seconds (spec #12, story 99). */
export const resumeAfterSetting = 'autoPause.resumeAfter';
const defaultResumeAfterSeconds = 2;

/** The quiet period in ms: the setting, or 2 s when it is unset or not a number above 0. */
export function readResumeAfterMs(config: Pick<Config, 'get'>): number {
  const value = config.get(resumeAfterSetting);
  const seconds =
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : defaultResumeAfterSeconds;
  return seconds * 1000;
}

/**
 * Who started the Loaded Lesson playing:
 * - `learner`: the play/pause command's `play`, or a play the core did not ask for (the learner's
 *   click on the picture, the native controls);
 * - `autoplay`: a `load` with autoplay (a picked Lesson, the next Lesson, a moved or reloaded page);
 * - `autoResume`: auto-pause's own resume after the quiet period.
 */
export type PlaySource = 'learner' | 'autoplay' | 'autoResume';

/** A mode in which auto-pause acts. */
export type AutoPauseOnMode = Exclude<AutoPauseMode, 'off'>;

/**
 * - `off`: the setting is off.
 * - `armed`: an edit while the Lesson plays pauses it.
 * - `autoPaused`: an edit paused the Lesson, and it has not played since. With `pauseAndResume`
 *   the quiet period runs (the `resumeAfter` setting): when it passes, auto-pause resumes it.
 * - `overridden`: the learner played the Lesson auto-pause paused, so typing plays through until
 *   the next pause of any kind (story 102); then it is armed again.
 */
export type AutoPauseState =
  | { readonly kind: 'off' }
  | { readonly kind: 'armed' | 'autoPaused' | 'overridden'; readonly mode: AutoPauseOnMode };

export const autoPauseOff: AutoPauseState = { kind: 'off' };

export type AutoPauseInput =
  /** The setting changed, or is read for the first time. */
  | { readonly type: 'modeChanged'; readonly mode: AutoPauseMode }
  /** The learner edited the active editor's document; `playing`: the Lesson is playing. */
  | { readonly type: 'typed'; readonly playing: boolean }
  /** The player reports the Loaded Lesson playing; `source`: who started it (ADR 0052). */
  | { readonly type: 'played'; readonly source: PlaySource }
  /**
   * The player reports the Loaded Lesson paused, whoever paused it. `refused`: VS Code refused the
   * `play` sent to it (#12 D3), auto-pause's own resume or the learner's.
   */
  | { readonly type: 'paused'; readonly refused: boolean }
  /**
   * A new player page replaces the one that held the Lesson: a move (ADR 0049) or a reload. It
   * has had no click, so VS Code would refuse a resume there (#12 D3).
   */
  | { readonly type: 'pageReplaced' }
  /**
   * The learner paused the Lesson themselves: the play/pause command sent `pause`, or the player
   * reports a pause of theirs (`paused {byUser: true}`). Spec: "a manual pause during `autoPaused`
   * … becomes a manual pause".
   */
  | { readonly type: 'learnerPaused' }
  /** The Loaded Lesson is over: it ended, or the learner left it (another Lesson or Course, a closed player). */
  | { readonly type: 'lessonOver' }
  /**
   * The quiet period of `pauseAndResume` passed with no edit. `canResume`: the page that holds the
   * Lesson is ready and has reported it paused.
   */
  | { readonly type: 'quiet'; readonly canResume: boolean };

/**
 * What the Loaded Lesson does for a step:
 * - `pause`: sends the player `pause`;
 * - `startQuiet`: starts the quiet period of `pauseAndResume` (the `resumeAfter` setting) again
 *   from now; when it passes, the Loaded Lesson feeds `quiet`;
 * - `cancelQuiet`: stops the quiet period under way, if any;
 * - `resume`: resumes the Lesson with no rewind (story 103).
 */
export type AutoPauseEffect = 'pause' | 'startQuiet' | 'cancelQuiet' | 'resume';

export interface AutoPauseStep {
  readonly state: AutoPauseState;
  readonly effects: readonly AutoPauseEffect[];
}

/**
 * Whether the quiet period runs in `state`: while auto-pause holds a pause it caused, in
 * `pauseAndResume`. It starts when such a state begins, and stops when it ends.
 */
function quietRuns(
  state: AutoPauseState,
): state is { readonly kind: 'autoPaused'; readonly mode: 'pauseAndResume' } {
  return state.kind === 'autoPaused' && state.mode === 'pauseAndResume';
}

/** The next state, and what to do, after `input`. Pure: the clock and the player are the caller's. */
export function stepAutoPause(state: AutoPauseState, input: AutoPauseInput): AutoPauseStep {
  const step = transition(state, input);
  if (quietRuns(state) === quietRuns(step.state)) {
    return step;
  }
  return {
    state: step.state,
    effects: [...step.effects, quietRuns(step.state) ? 'startQuiet' : 'cancelQuiet'],
  };
}

/** The next state, and what to do besides starting or stopping the quiet period. */
function transition(state: AutoPauseState, input: AutoPauseInput): AutoPauseStep {
  switch (input.type) {
    case 'modeChanged':
      if (input.mode === 'off') {
        return { state: autoPauseOff, effects: [] };
      }
      // Another mode keeps where it is: a pause it caused is still one it caused.
      return {
        state:
          state.kind === 'off'
            ? { kind: 'armed', mode: input.mode }
            : { ...state, mode: input.mode },
        effects: [],
      };
    case 'typed':
      if (quietRuns(state)) {
        // Still typing: the quiet period starts again from this edit.
        return { state, effects: ['startQuiet'] };
      }
      return state.kind === 'armed' && input.playing
        ? { state: { ...state, kind: 'autoPaused' }, effects: ['pause'] }
        : { state, effects: [] };
    case 'quiet':
      if (!quietRuns(state)) {
        return { state, effects: [] };
      }
      // A pause it cannot resume is left as a plain pause: "Paused (typing)" goes.
      return input.canResume
        ? { state, effects: ['resume'] }
        : { state: { ...state, kind: 'armed' }, effects: [] };
    case 'played':
      // The learner playing a Lesson auto-pause paused lets typing play through (story 102). Its
      // own resume, or a `load`'s autoplay, ends the pause it caused: the next edit pauses again.
      if (state.kind !== 'autoPaused') {
        return { state, effects: [] };
      }
      return {
        state: { ...state, kind: input.source === 'learner' ? 'overridden' : 'armed' },
        effects: [],
      };
    case 'paused':
      // The next pause of any kind ends `overridden`. A pause while `autoPaused` is the one it
      // sent, unless it answers a refused `play`: then the Lesson stays paused, a plain pause.
      if (state.kind === 'overridden' || (state.kind === 'autoPaused' && input.refused)) {
        return { state: { ...state, kind: 'armed' }, effects: [] };
      }
      return { state, effects: [] };
    case 'learnerPaused':
    case 'lessonOver':
    case 'pageReplaced':
      // Paused by the learner, so the pause is theirs; or no longer the Lesson it paused: what it
      // paused or let play through is over, and the next edit while a Lesson plays pauses it.
      return { state: state.kind === 'off' ? state : { ...state, kind: 'armed' }, effects: [] };
  }
}

/** What the learner is shown of auto-pause: the mode (the marker), and whether it paused the Lesson. */
export interface AutoPauseView {
  readonly autoPause: AutoPauseMode;
  readonly pausedByTyping: boolean;
}

export function autoPauseView(state: AutoPauseState): AutoPauseView {
  return state.kind === 'off'
    ? { autoPause: 'off', pausedByTyping: false }
    : { autoPause: state.mode, pausedByTyping: state.kind === 'autoPaused' };
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
    edit.scheme === 'file' && edit.path !== undefined && !isCourseDataFile(edit.path, storageFolder)
  );
}
