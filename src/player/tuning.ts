/**
 * Knobs Seam 2 tests set (through `window.followalongPlayerTuning`, before the page loads) to make
 * a few seconds of fixture behave like a long Lesson. VS Code never sets them, so the player runs
 * with the defaults there.
 */
export interface PlayerTuning {
  /** Network bytes gathered into one append. */
  readonly appendBytes?: number;
  /** Already-played media kept buffered when room is needed. */
  readonly keepBehindSeconds?: number;
  /**
   * Treat the source buffer as full once it holds this many seconds, as Chromium does at its
   * ~150 MB MediaSource quota, so eviction and re-streaming happen with a small fixture.
   */
  readonly quotaSeconds?: number;
}

declare global {
  interface Window {
    followalongPlayerTuning?: PlayerTuning;
  }
}

export const defaultTuning = {
  appendBytes: 1024 * 1024,
  keepBehindSeconds: 30,
  quotaSeconds: Number.POSITIVE_INFINITY,
} as const satisfies Required<PlayerTuning>;
