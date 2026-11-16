/**
 * Decides when the learner is done with the player, so the extension hands focus back (Focus
 * return, ADR 0009). An interaction is reported when it ends: a click, a key release, a change made
 * with a native control. A gesture that is still under way holds the report until it ends, so
 * focus never leaves in the middle of a drag. Signals that arrive together (the end of a seek-bar
 * drag, then Chromium playing on by itself) make one report.
 */

/**
 * How long the player waits, after it takes focus or after a held press or key is let go, for a
 * gesture or a change to report the click first.
 */
export const focusGraceMs = 250;
/** How often a pending focus check looks again whether a press or a key is still held. */
const heldPollMs = 50;

export class Interactions {
  /** The pointers whose gesture is under way: native sliders and zoom-area drags; later pans. */
  private readonly gestures = new Set<number>();
  /** Set from a report being due until it is posted. */
  private reportDue = false;
  /** The pending check after the player took focus. */
  private focusCheck: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param report posts the interaction.
   * @param held whether a press (on the native control bar too) or a key is still held down: a
   *   held press is not finished, so it is not reported until it is let go.
   */
  constructor(
    private readonly report: () => void,
    private readonly held: () => boolean,
  ) {}

  /** The learner finished something in the player: reported, unless a gesture is under way. */
  ended(): void {
    if (this.gestures.size === 0) {
      this.reportSoon();
    }
  }

  /**
   * A gesture began that must not lose focus before it ends: a drag of a native slider (seek bar
   * or volume), a zoom-area drag (ADR 0037); later a pan (#47). Nothing is reported until every
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
   * to itself, so a click on an empty part of it shows only as this. Unless a gesture begins (a
   * press on the seek bar) or something else reports the click first, it is reported once nothing
   * has been held for {@link focusGraceMs}: a press or key held longer is reported on release.
   */
  focused(): void {
    this.cancelFocusCheck();
    let quietSince = Date.now();
    const check = () => {
      if (this.held()) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= focusGraceMs) {
        this.focusCheck = undefined;
        this.ended();
        return;
      }
      this.focusCheck = setTimeout(check, heldPollMs);
    };
    this.focusCheck = setTimeout(check, heldPollMs);
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
