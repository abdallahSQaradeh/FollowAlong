/**
 * The status bar items as a view model for the UI sink: play/pause, time, speed and back, shown
 * while a Lesson is loaded and gone otherwise. The core builds the model; the adapter only draws
 * it and runs the command a click names (spec #12, story 47).
 */

/** The commands a status bar item can run when clicked, named as the core knows them. */
export type StatusBarCommand = 'playPause' | 'speedCycle' | 'seekBackShort';

export type StatusBarIcon = 'play' | 'pause' | 'back';

/** Every command a status bar item can name; the type makes a new one a compile error here. */
const statusBarCommands: Readonly<Record<StatusBarCommand, true>> = {
  playPause: true,
  speedCycle: true,
  seekBackShort: true,
};

/** Whether `value` names a command a status bar item can run; a click comes in as plain data. */
export function isStatusBarCommand(value: unknown): value is StatusBarCommand {
  return typeof value === 'string' && Object.hasOwn(statusBarCommands, value);
}

export type StatusBarItemId = 'playPause' | 'time' | 'speed' | 'back';

export interface StatusBarItemModel {
  /** Stable across updates: the adapter keeps one item per id, in the order of the list. */
  readonly id: StatusBarItemId;
  /** A symbol drawn before the text, named by what it shows; the adapter picks the picture. */
  readonly icon?: StatusBarIcon;
  /** The text on the item; empty for an item that is only a symbol. */
  readonly text: string;
  readonly tooltip: string;
  /** What a click runs; absent for an item that only shows. */
  readonly command?: StatusBarCommand;
}

/** No items: nothing to show. */
export interface StatusBarModel {
  readonly items: readonly StatusBarItemModel[];
}

export const hiddenStatusBar: StatusBarModel = { items: [] };

/** What the items show, as far as the player has reported it. */
export interface StatusBarState {
  readonly playing: boolean;
  /** Seconds from the start of the Lesson. */
  readonly position: number;
  /** Seconds; 0 while the player does not know the length yet. */
  readonly duration: number;
  readonly rate: number;
  /** The short step, in seconds. */
  readonly shortStep: number;
}

const secondsPerMinute = 60;
const unknownTime = '--:--';

/** `mm:ss`, with minutes past 59 kept as minutes (`65:30`). */
function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / secondsPerMinute);
  const rest = whole % secondsPerMinute;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function buildStatusBar(state: StatusBarState): StatusBarModel {
  return {
    items: [
      {
        id: 'playPause',
        icon: state.playing ? 'pause' : 'play',
        text: '',
        tooltip: state.playing ? 'Pause the Lesson' : 'Play the Lesson',
        command: 'playPause',
      },
      {
        id: 'time',
        text: `${clock(state.position)} / ${state.duration > 0 ? clock(state.duration) : unknownTime}`,
        tooltip: 'Position / length of the Lesson',
      },
      {
        id: 'speed',
        text: `${String(state.rate)}×`,
        tooltip: 'Playback speed: click for the next speed',
        command: 'speedCycle',
      },
      {
        id: 'back',
        icon: 'back',
        text: `${String(state.shortStep)}s`,
        tooltip: `Back ${String(state.shortStep)} seconds`,
        command: 'seekBackShort',
      },
    ],
  };
}
