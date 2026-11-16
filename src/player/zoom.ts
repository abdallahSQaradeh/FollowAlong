/**
 * Zoom to an area of the picture (spec #12, Player; ADR 0037). The learner drags a box over the
 * picture and the player shows that area enlarged, so the instructor's code can be read.
 *
 * The view is kept as fractions of the whole picture, not in pixels, so it stays on the same area
 * when the player is resized or moved to another spot (#49), and can be stored as it is.
 */

import {
  maxZoomLevel,
  shownZoomLevel,
  wholePicture,
  type ZoomView,
} from '../protocol/player-messages.js';

export type { ZoomView } from '../protocol/player-messages.js';
export { isZoomView, wholePicture } from '../protocol/player-messages.js';

/** How much one press of ＋ or − zooms in or out (from the prototype). */
export const zoomStep = 1.25;

/** A box on the player, in fractions of the player's width and height. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The view at `level`, centred as close to (`centreX`, `centreY`) as the picture's edges allow. A
 * level that would read `1×` is the whole picture: a box over nearly all of it zooms nothing,
 * rather than hiding the control bar at a zoom the learner cannot see.
 */
function centredView(level: number, centreX: number, centreY: number): ZoomView {
  if (shownZoomLevel(level) <= 1) {
    return wholePicture;
  }
  const clamped = Math.min(level, maxZoomLevel);
  const span = 1 / clamped;
  return {
    level: clamped,
    left: clamp(centreX - span / 2, 0, 1 - span),
    top: clamp(centreY - span / 2, 0, 1 - span),
  };
}

/** The view that fills the player with what `box` covers in `view` now. */
export function zoomToBox(view: ZoomView, box: Box): ZoomView {
  const centreX = view.left + (box.x + box.width / 2) / view.level;
  const centreY = view.top + (box.y + box.height / 2) / view.level;
  return centredView(view.level / Math.max(box.width, box.height), centreX, centreY);
}

/** The view `factor` times closer (below 1: further), around the middle of what is shown now. */
export function zoomBy(view: ZoomView, factor: number): ZoomView {
  const span = 1 / view.level;
  return centredView(view.level * factor, view.left + span / 2, view.top + span / 2);
}

/**
 * The view after the picture was dragged by (`dx`, `dy`), as fractions of the player's width and
 * height: the picture follows the pointer, so the area shown moves the other way. It stays inside
 * the picture.
 */
export function panBy(view: ZoomView, dx: number, dy: number): ZoomView {
  const span = 1 / view.level;
  return {
    level: view.level,
    left: clamp(view.left - dx * span, 0, 1 - span),
    top: clamp(view.top - dy * span, 0, 1 - span),
  };
}

/** The CSS transform of the video that shows `view` (its transform origin is its top left). */
export function zoomTransform(view: ZoomView): string {
  // A translate percentage is of the video's own box, which is the player's size.
  const x = -view.left * view.level * 100;
  const y = -view.top * view.level * 100;
  return `translate(${String(x)}%, ${String(y)}%) scale(${String(view.level)})`;
}
