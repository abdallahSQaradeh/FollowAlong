/**
 * Decides when the learner is done with the player, so the extension hands focus back (Focus
 * return, ADR 0009). An interaction is reported when it ends: a click, a key release, a change made
 * with a native control. A gesture that is still under way holds the report until it ends, so
 * focus never leaves in the middle of a drag.
 */
export class Interactions {
  /** Set from the start of a gesture until it ends. */
  private gestureUnderWay = false;

  constructor(private readonly report: () => void) {}

  /** The learner finished something in the player: reported, unless a gesture is under way. */
  ended(): void {
    if (!this.gestureUnderWay) {
      this.report();
    }
  }

  /**
   * A gesture began that must not lose focus before it ends: today a drag of a native slider
   * (seek bar or volume); later a zoom-area drag or a pan (#46, #47). Nothing is reported until
   * {@link endGesture}.
   */
  beginGesture(): void {
    this.gestureUnderWay = true;
  }

  /** The gesture ended: it is reported as one interaction. */
  endGesture(): void {
    this.gestureUnderWay = false;
    this.report();
  }
}
