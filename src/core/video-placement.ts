/**
 * Where the video sits (spec #12, Placement manager; ADR 0049): the spots the player can be in,
 * the default spot from the `followalong.videoLocation` setting, and the quick pick behind
 * _Move video to…_.
 */
import type { Config } from './ports.js';

/**
 * A spot the player can sit in:
 * - `editorSplit`: an editor group beside the code (the default);
 * - `bottomPanel`: a view in the bottom panel, beside the terminal;
 * - `secondarySidebar`: a view in the secondary sidebar.
 */
export type VideoSpot = 'editorSplit' | 'bottomPanel' | 'secondarySidebar';

/** Every spot, in the order _Move video to…_ lists them. */
export const videoSpots: readonly VideoSpot[] = ['editorSplit', 'bottomPanel', 'secondarySidebar'];

export const defaultVideoSpot: VideoSpot = 'editorSplit';

export function isVideoSpot(value: unknown): value is VideoSpot {
  return videoSpots.some((spot) => spot === value);
}

/** The spot a new player opens in: the `followalong.videoLocation` setting, read when it opens. */
export function settingSpot(config: Pick<Config, 'get'>): VideoSpot {
  const value = config.get('videoLocation');
  return isVideoSpot(value) ? value : defaultVideoSpot;
}
