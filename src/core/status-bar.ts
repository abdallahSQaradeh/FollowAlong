/**
 * The status bar items as a view model for the UI sink: play/pause, time, speed and back, shown
 * while a Lesson is loaded and gone otherwise, and the zoom level while the picture is zoomed. The
 * core builds the model; the adapter only draws it and runs the command a click names (spec #12,
 * stories 47 and 63).
 */
import { zoomLabel } from '../protocol/player-messages.js';

import type { AutoPauseMode } from './auto-pause.js';
import { formatClock } from './clock-text.js';

/** The commands a status bar item can run when clicked, named as the core knows them. */
export type StatusBarCommand = 'playPause' | 'speedCycle' | 'seekBackShort' | 'zoomReset';

export type StatusBarIcon = 'play' | 'pause' | 'back' | 'zoom';

/** Every command a status bar item can name; the type makes a new one a compile error here. */
const statusBarCommands: Readonly<Record<StatusBarCommand, true>> = {
  playPause: true,
  speedCycle: true,
  seekBackShort: true,
  zoomReset: true,
};

/** Whether `value` names a command a status bar item can run; a click comes in as plain data. */
export function isStatusBarCommand(value: unknown): value is StatusBarCommand {
  return typeof value === 'string' && Object.hasOwn(statusBarCommands, value);
}

/** A second symbol after the icon: `autoPause` while auto-pause is on (story 104). */
export type StatusBarMarker = 'autoPause';

export type StatusBarItemId = 'playPause' | 'time' | 'speed' | 'back' | 'zoom';

export interface StatusBarItemModel {
  /** Stable across updates: the adapter keeps one item per id, in the order of the list. */
  readonly id: StatusBarItemId;
  /** A symbol drawn before the text, named by what it shows; the adapter picks the picture. */
  readonly icon?: StatusBarIcon;
  /** A symbol drawn after the icon, named by what it says; the adapter picks the picture. */
  readonly marker?: StatusBarMarker;
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
  /** The player's zoom level: 1 is the whole picture (ADR 0037). */
  readonly zoom: number;
  /** The `followalong.autoPause` setting (ADR 0052). */
  readonly autoPause: AutoPauseMode;
}

/** How each mode of auto-pause is named in the play/pause item's tooltip. */
const autoPauseNames: Readonly<Record<Exclude<AutoPauseMode, 'off'>, string>> = {
  pause: 'pause',
  pauseAndResume: 'pause and resume',
};

const unknownTime = '--:--';

/** The play/pause item, with the auto-pause marker while auto-pause is on. */
function playPauseItem(state: StatusBarState): StatusBarItemModel {
  const action = state.playing ? 'Pause the Lesson' : 'Play the Lesson';
  const common = {
    id: 'playPause',
    icon: state.playing ? 'pause' : 'play',
    text: '',
    command: 'playPause',
  } as const;
  return state.autoPause === 'off'
    ? { ...common, tooltip: action }
    : {
        ...common,
        marker: 'autoPause',
        tooltip: `${action} · Auto-pause: ${autoPauseNames[state.autoPause]}`,
      };
}

export function buildStatusBar(state: StatusBarState): StatusBarModel {
  return {
    items: [
      playPauseItem(state),
      {
        id: 'time',
        text: `${formatClock(state.position)} / ${state.duration > 0 ? formatClock(state.duration) : unknownTime}`,
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
      // Only while zoomed, so the learner always knows the picture is not whole (story 63).
      ...(state.zoom > 1
        ? [
            {
              id: 'zoom',
              icon: 'zoom',
              text: zoomLabel(state.zoom),
              tooltip: `Zoomed to ${zoomLabel(state.zoom)}: click to show the whole picture`,
              command: 'zoomReset',
            } as const,
          ]
        : []),
    ],
  };
}
