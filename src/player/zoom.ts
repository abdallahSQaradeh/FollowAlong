/**
 * Zoom to an area of the picture (spec #12, Player; ADR 0037). The learner drags a box over the
 * picture and the player shows that area enlarged, so the instructor's code can be read.
 *
 * The view is kept as fractions of the whole picture, not in pixels, so it stays on the same area
 * when the player is resized or moved to another spot (#49), and can be stored as it is.
 */

/** What part of the whole picture is shown. */
export interface ZoomView {
  /** 1 shows the whole picture; 2 shows half its width and half its height. */
  readonly level: number;
  /** The left edge of the shown area, as a fraction of the picture's width. */
  readonly left: number;
  /** The top edge of the shown area, as a fraction of the picture's height. */
  readonly top: number;
}

export const wholePicture: ZoomView = { level: 1, left: 0, top: 0 };

/** The closest the learner can zoom in (from the prototype: further is only blur). */
export const maxZoomLevel = 8;

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

/** The view at `level`, centred as close to (`centreX`, `centreY`) as the picture's edges allow. */
function centredView(level: number, centreX: number, centreY: number): ZoomView {
  const zoom = clamp(level, 1, maxZoomLevel);
  const span = 1 / zoom;
  return {
    level: zoom,
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

/** Whether `value` is a view the player can show; stored state comes back as plain data. */
export function isZoomView(value: unknown): value is ZoomView {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { level, left, top } = value as Readonly<Record<string, unknown>>;
  return (
    typeof level === 'number' &&
    typeof left === 'number' &&
    typeof top === 'number' &&
    level >= 1 &&
    level <= maxZoomLevel &&
    left >= 0 &&
    top >= 0 &&
    left <= 1 - 1 / level &&
    top <= 1 - 1 / level
  );
}

/** The CSS transform of the video that shows `view` (its transform origin is its top left). */
export function zoomTransform(view: ZoomView): string {
  // A translate percentage is of the video's own box, which is the player's size.
  const x = -view.left * view.level * 100;
  const y = -view.top * view.level * 100;
  return `translate(${String(x)}%, ${String(y)}%) scale(${String(view.level)})`;
}
