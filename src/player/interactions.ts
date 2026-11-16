/**
 * Decides when the learner is done with the player, so the extension hands focus back (Focus
 * return, ADR 0009). An interaction is reported when it ends: a click, a key release, a change made
 * with a native control. A gesture that is still under way holds the report until it ends, so
 * focus never leaves in the middle of a drag. Signals that arrive together (the end of a seek-bar
 * drag, then Chromium playing on by itself) make one report.
 */

/** How long after the player takes focus a gesture may still begin before the click counts. */
export const focusGraceMs = 250;

export class Interactions {
  /** The pointers whose gesture is under way: today native sliders; later zoom drags and pans. */
  private readonly gestures = new Set<number>();
  /** Set from a report being due until it is posted. */
  private reportDue = false;
  /** The pending check after the player took focus. */
  private focusCheck: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly report: () => void) {}

  /** The learner finished something in the player: reported, unless a gesture is under way. */
  ended(): void {
    if (this.gestures.size === 0) {
      this.reportSoon();
    }
  }

  /**
   * A gesture began that must not lose focus before it ends: a drag of a native slider (seek bar
   * or volume); later a zoom-area drag or a pan (#46, #47). Nothing is reported until every
   * gesture under way has ended.
   */
  beginGesture(pointerId: number): void {
    this.gestures.add(pointerId);
    this.cancelFocusCheck();
  }

  /** The gesture of this pointer ended: once none is left, it is reported as one interaction. */
  endGesture(pointerId: number): void {
    if (this.gestures.delete(pointerId) && this.gestures.size === 0) {
      this.reportSoon();
    }
  }

  /**
   * Something in the player took keyboard focus. Chromium's control bar keeps its pointer events
   * to itself, so a click on an empty part of it shows only as this. Unless a gesture begins at
   * once (a press on the seek bar) or something else reports the click first, it is reported
   * after {@link focusGraceMs}.
   */
  focused(): void {
    this.cancelFocusCheck();
    this.focusCheck = setTimeout(() => {
      this.focusCheck = undefined;
      this.ended();
    }, focusGraceMs);
  }

  private reportSoon(): void {
    this.cancelFocusCheck();
    if (this.reportDue) {
      return;
    }
    this.reportDue = true;
    setTimeout(() => {
      this.reportDue = false;
      this.report();
    }, 0);
  }

  private cancelFocusCheck(): void {
    if (this.focusCheck !== undefined) {
      clearTimeout(this.focusCheck);
      this.focusCheck = undefined;
    }
  }
}
