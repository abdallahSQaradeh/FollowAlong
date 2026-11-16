/**
 * Where the video sits (spec #12, Placement manager; ADR 0049): the spots the player can be in,
 * the default spot from the `followalong.videoLocation` setting, and the quick pick behind
 * _Move video to…_.
 */
import type { Config } from './ports.js';
import type { QuickPickModel } from './quick-pick.js';

/**
 * A spot the player can sit in:
 * - `editorSplit`: an editor group beside the code (the default);
 * - `bottomPanel`: a view in the bottom panel, beside the terminal;
 * - `secondarySidebar`: a view in the secondary sidebar;
 * - `miniStrip`: a short editor group above the code (ADR 0100).
 */
export type VideoSpot = 'editorSplit' | 'bottomPanel' | 'secondarySidebar' | 'miniStrip';

/** Every spot, in the order _Move video to…_ lists them. */
export const videoSpots: readonly VideoSpot[] = [
  'editorSplit',
  'bottomPanel',
  'secondarySidebar',
  'miniStrip',
];

export const defaultVideoSpot: VideoSpot = 'editorSplit';

export function isVideoSpot(value: unknown): value is VideoSpot {
  return videoSpots.some((spot) => spot === value);
}

/** The spot a new player opens in: the `followalong.videoLocation` setting, read when it opens. */
export function settingSpot(config: Pick<Config, 'get'>): VideoSpot {
  const value = config.get('videoLocation');
  return isVideoSpot(value) ? value : defaultVideoSpot;
}

/** How each spot is named to the learner. */
export const spotLabels: Readonly<Record<VideoSpot, string>> = {
  editorSplit: 'Editor group beside the code',
  bottomPanel: 'Bottom panel',
  secondarySidebar: 'Secondary sidebar',
  miniStrip: 'Mini strip above the code',
};

/** The quick pick of _Move video to…_: every spot, the one the player is in marked. */
export function buildSpotPicker(current: VideoSpot): QuickPickModel<VideoSpot> {
  return {
    title: 'Move video to…',
    placeholder: 'Where the video sits; it keeps its time, speed and zoom',
    matchOnDescription: false,
    entries: videoSpots.map((spot) => ({
      kind: 'item',
      label: spotLabels[spot],
      ...(spot === current ? { description: 'where it is now' } : {}),
      intent: spot,
    })),
  };
}
