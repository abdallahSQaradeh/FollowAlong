/**
 * The rules that give a Lesson its Progress state without the learner marking it (spec #12,
 * Progress store; ADR 0030). Pure: they know nothing of the player, the clock or the file.
 *
 * - A Lesson is **not started** until it has played for 10 s, so a stray click changes nothing.
 * - It is **in progress** after that.
 * - It is **done** when the playhead reaches its last 5 % or its end, also by seeking. Done is
 *   sticky: only the learner un-marks it, never a seek back or more play.
 * - A done Lesson whose saved position is in its last 5 % starts again at 0:00.
 */

/** How the Course data file marks a Lesson. A Lesson with no mark is not started. */
export type StoredStatus = 'inProgress' | 'done';

/** The state of a Lesson in a Course's Progress. */
export type LessonStatus = 'notStarted' | StoredStatus;

/** How long a Lesson plays before it counts as in progress, in seconds of picture played. */
export const inProgressAfterSeconds = 10;

/** The fraction of a Lesson's length at which the Lesson is done. */
export const doneAtFraction = 0.95;

/** What the player reported since the Lesson was last recorded. */
export interface PlayheadSeen {
  /** Where the playhead is, in seconds. */
  readonly position: number;
  /** The Lesson's length in seconds; 0 while the player does not know it (ADR 0006). */
  readonly duration: number;
  /** How many seconds of picture played since the Lesson was loaded. */
  readonly playedSeconds: number;
  /** Whether the Lesson played to its end. */
  readonly ended: boolean;
}

/** Whether `position` is in the last 5 % of a Lesson `duration` long (never for an unknown length). */
export function inLastFivePercent(position: number, duration: number): boolean {
  return duration > 0 && position >= duration * doneAtFraction;
}

/** The status a Lesson is in after the player reported `seen`, given the status it had. */
export function statusAfter(before: LessonStatus, seen: PlayheadSeen): LessonStatus {
  if (before === 'done' || seen.ended || inLastFivePercent(seen.position, seen.duration)) {
    return 'done';
  }
  return before === 'inProgress' || seen.playedSeconds >= inProgressAfterSeconds
    ? 'inProgress'
    : 'notStarted';
}

/** How far before a saved position a Lesson starts again (spec #12, Resume), in seconds. */
export const secondsBeforeSavedPosition = 5;

/**
 * Where a Lesson starts when the learner comes back to it. A done Lesson saved in its last 5 %
 * starts again at 0:00 (story 81); any other starts 5 s before its saved position.
 */
export function startPosition(
  saved: { readonly position: number; readonly duration: number } | undefined,
  status: LessonStatus,
): number {
  if (
    saved === undefined ||
    (status === 'done' && inLastFivePercent(saved.position, saved.duration))
  ) {
    return 0;
  }
  return Math.max(0, saved.position - secondsBeforeSavedPosition);
}
