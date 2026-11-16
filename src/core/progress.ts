/**
 * The Progress store (spec #12, Core modules → Progress store; ADR 0010): where the learner is in
 * each Lesson of a Course, kept with the Course in `.followalong/progress.json` (or the fallback
 * storage, ADR 0005), keyed by the Lesson's path relative to the Course, so moving or renaming the
 * Course folder keeps it.
 */
import { basename } from 'node:path';

import {
  CourseDataBusyError,
  openCourseData,
  UnreadableCourseDataError,
  type CourseDataFile,
} from './course-data.js';
import {
  startPosition,
  statusAfter,
  type LessonStatus,
  type PlayheadSeen,
  type StoredStatus,
} from './lesson-status.js';
import { FileSystemError, type Ports } from './ports.js';

/** What is kept for one Lesson. */
export interface LessonProgress {
  /** Seconds from the start of the Lesson: where the playhead was at the last save. */
  readonly position: number;
  /** The Lesson's length in seconds, as the player last reported it (0 while unknown). */
  readonly duration: number;
  /** When this entry was saved (ms since the epoch), so the newer of two copies wins. */
  readonly savedAt: number;
  /** Whether the Lesson is in progress or done (ADR 0030); no mark means not started. */
  readonly status?: StoredStatus;
  /**
   * When the learner last set the status by hand (mark done, reset), 0 when never (ms since the
   * epoch). Play raises the status but keeps this stamp. Two copies of an entry merge their places
   * by `savedAt` and their statuses by this, so a done mark is not lost to another window's newer
   * save of the place, nor a reset to a done mark another window still holds (ADR 0074). Absent
   * when it equals `savedAt`.
   */
  readonly statusAt?: number;
}

/** The Lesson played last in the Course. */
export interface LastLesson {
  /** The Lesson's id, or {@link noLastLesson} after the Course's Progress was reset. */
  readonly lessonId: string;
  readonly savedAt: number;
}

/** The `lessonId` of a {@link LastLesson} that says no Lesson was played last (ADR 0061). */
export const noLastLesson = '';

/** Version 1 of `progress.json`'s `data`. */
export interface CourseProgress {
  /** By Lesson id (the Lesson's path in the Course, with `/`). */
  readonly lessons: Readonly<Record<string, LessonProgress>>;
  readonly last?: LastLesson;
}

function isFields(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseLesson(raw: unknown): LessonProgress | undefined {
  if (!isFields(raw)) {
    return undefined;
  }
  const { position, duration, savedAt, status, statusAt } = raw;
  if (!isSeconds(position) || !isSeconds(duration) || !isSeconds(savedAt)) {
    return undefined;
  }
  if (statusAt !== undefined && !isSeconds(statusAt)) {
    return undefined;
  }
  const stamp = statusAt === undefined ? {} : { statusAt };
  if (status === undefined) {
    return { position, duration, savedAt, ...stamp };
  }
  return status === 'inProgress' || status === 'done'
    ? { position, duration, savedAt, status, ...stamp }
    : undefined;
}

export const progressFile: CourseDataFile<CourseProgress> = {
  name: 'progress.json',
  version: 1,
  parse(data) {
    if (!isFields(data) || !isFields(data.lessons)) {
      return undefined;
    }
    const lessons: [string, LessonProgress][] = [];
    for (const [lessonId, raw] of Object.entries(data.lessons)) {
      const lesson = parseLesson(raw);
      if (lesson === undefined) {
        return undefined;
      }
      lessons.push([lessonId, lesson]);
    }
    const { last } = data;
    if (last === undefined) {
      return { lessons: Object.fromEntries(lessons) };
    }
    if (!isFields(last) || typeof last.lessonId !== 'string' || !isSeconds(last.savedAt)) {
      return undefined;
    }
    return {
      lessons: Object.fromEntries(lessons),
      last: { lessonId: last.lessonId, savedAt: last.savedAt },
    };
  },
  merge: mergeProgress,
};

/** A Lesson's entry: only the record's own keys count, never one inherited from `Object`. */
export function lessonEntry(
  lessons: Readonly<Record<string, LessonProgress>>,
  lessonId: string,
): LessonProgress | undefined {
  return Object.hasOwn(lessons, lessonId) ? lessons[lessonId] : undefined;
}

/**
 * When an entry's status was set: its `statusAt`, else `savedAt`. An entry without `statusAt` was
 * written before it existed (a reset of ADR 0061 among them) or by an older FollowAlong, and its
 * whole entry was saved at `savedAt`. A status never set is written as `statusAt: 0`.
 */
function statusSetAt(entry: LessonProgress): number {
  return entry.statusAt ?? entry.savedAt;
}

/** An entry with this place and status; `statusAt` is written only when it is not the default. */
function entryOf(
  place: Pick<LessonProgress, 'position' | 'duration' | 'savedAt'>,
  status: StoredStatus | undefined,
  statusAt: number,
): LessonProgress {
  const { position, duration, savedAt } = place;
  const entry: LessonProgress =
    status === undefined
      ? { position, duration, savedAt }
      : { position, duration, savedAt, status };
  return statusSetAt(entry) === statusAt ? entry : { ...entry, statusAt };
}

/** How far a status has come: play only ever raises it. */
const statusRank: Readonly<Record<LessonStatus, number>> = {
  notStarted: 0,
  inProgress: 1,
  done: 2,
};

/**
 * Of two entries, the one whose place counts: saved later; on the same `savedAt`, the larger
 * position, then the longer duration, so the merge does not depend on the order of the copies.
 */
function placeHolder(a: LessonProgress, b: LessonProgress): LessonProgress {
  const order = b.savedAt - a.savedAt || b.position - a.position || b.duration - a.duration;
  return order > 0 ? b : a;
}

/**
 * Of two entries, the one whose status counts (D14 on #12, ADR 0074): the one set by hand later;
 * on the same `statusAt`, the higher status. Equal stamps mean both rose by play from the same
 * status set by hand (or from never), and play only raises.
 */
function statusHolder(a: LessonProgress, b: LessonProgress): LessonProgress {
  const order =
    statusSetAt(b) - statusSetAt(a) ||
    statusRank[b.status ?? 'notStarted'] - statusRank[a.status ?? 'notStarted'];
  return order > 0 ? b : a;
}

/**
 * Two entries of one Lesson (ADR 0074): the place of {@link placeHolder} with the status of
 * {@link statusHolder}. Neither depends on the order of the two, so copies merge to the same
 * result in any order and grouping.
 */
function mergeEntry(a: LessonProgress, b: LessonProgress): LessonProgress {
  const place = placeHolder(a, b);
  const marked = statusHolder(a, b);
  return place === marked ? place : entryOf(place, marked.status, statusSetAt(marked));
}

/** The last Lesson played: the one saved later; on the same `savedAt`, the larger id. */
function laterLast(a: LastLesson | undefined, b: LastLesson | undefined): LastLesson | undefined {
  if (a === undefined || b === undefined) {
    return a ?? b;
  }
  const order = b.savedAt - a.savedAt || (b.lessonId > a.lessonId ? 1 : 0);
  return order > 0 ? b : a;
}

/**
 * Per Lesson, the place saved later and the status D14 gives (ADR 0074); for the last Lesson
 * played, the one saved later. The result does not depend on the order of `a` and `b`.
 */
function mergeProgress(a: CourseProgress, b: CourseProgress): CourseProgress {
  const lessons: Record<string, LessonProgress> = { ...a.lessons };
  for (const [lessonId, lesson] of Object.entries(b.lessons)) {
    const other = lessonEntry(lessons, lessonId);
    lessons[lessonId] = other === undefined ? lesson : mergeEntry(other, lesson);
  }
  const last = laterLast(a.last, b.last);
  return last === undefined ? { lessons } : { lessons, last };
}

/**
 * The `savedAt` for a change made now to a Lesson's entry: never at or before the entry's own, so
 * the change wins the per-Lesson merge of two copies even when the clock has not moved (or went
 * back).
 */
function savedAfter(before: { readonly savedAt: number } | undefined, now: number): number {
  return before === undefined ? now : Math.max(now, before.savedAt + 1);
}

/** The stamp of a status play leaves or raises: the entry's own, or never (0) for a new entry. */
function keptStatusAt(before: LessonProgress | undefined): number {
  return before === undefined ? 0 : statusSetAt(before);
}

/** The stamp for a change made now to a Lesson's status: after both of the entry's stamps. */
function changedAfter(before: LessonProgress | undefined, now: number): number {
  return before === undefined ? now : Math.max(now, before.savedAt + 1, statusSetAt(before) + 1);
}

/** A Lesson's state: not started, in progress or done (ADR 0030). */
export function lessonStatus(progress: CourseProgress, lessonId: string): LessonStatus {
  return lessonEntry(progress.lessons, lessonId)?.status ?? 'notStarted';
}

/**
 * Where a Lesson starts when the learner comes back to it: 5 s before its saved position, or 0:00
 * for a done Lesson saved in its last 5 %.
 */
export function resumePosition(progress: CourseProgress, lessonId: string): number {
  return startPosition(lessonEntry(progress.lessons, lessonId), lessonStatus(progress, lessonId));
}

/** One open Course's Progress: read once when the Course opens, saved as the learner goes. */
export interface ProgressRecorder {
  /** What is known now, including what is not saved yet. */
  current(): CourseProgress;
  /**
   * Notes what the player reported about a Lesson: where its playhead is, how long it played, and
   * whether it ended. The Lesson's status follows (ADR 0030); it is written by the next `save`.
   */
  record(lessonId: string, seen: PlayheadSeen): void;
  /**
   * Marks these Lessons done by hand, keeping each one's position. A Lesson with nothing saved gets
   * a done mark at 0:00. Written by the next `save`.
   */
  markDone(lessonIds: readonly string[]): void;
  /**
   * Resets these Lessons: their done marks and positions go, so each reads as never played. An
   * entry is written rather than removed: the newest entry per Lesson wins when two copies are
   * merged, and a removed one would come back from the other copy (ADR 0061). Written by the next
   * `save`.
   */
  reset(lessonIds: readonly string[]): void;
  /**
   * Resets every Lesson, and the Lesson the Course reopens on, as if the Course had never been
   * played. `lessonIds` are the Course's Lessons: another window may have saved some this one
   * never read (ADR 0074). Written by the next `save`.
   */
  resetAll(lessonIds: readonly string[]): void;
  /** Writes what was recorded since the last save, after any save already under way. */
  save(): Promise<void>;
}

type ProgressPorts = Pick<Ports, 'fileSystem' | 'storage' | 'clock' | 'ui' | 'logger'>;

export async function openProgress(
  course: string,
  ports: ProgressPorts,
): Promise<ProgressRecorder> {
  const { clock, ui, logger } = ports;
  const data = openCourseData(course, ports);
  let progress: CourseProgress = (await data.read(progressFile)) ?? { lessons: {} };
  /** Whether something was recorded since the last write. */
  let unsaved = false;
  /** Saves run one after another, so an older one never lands after a newer one. */
  let saving: Promise<void> = Promise.resolve();
  /** The learner is told about a failing or refused save once per open Course, not every 5 s. */
  let failureShown = false;
  /** The learner is told once that Progress went to the extension storage instead. */
  let keptElsewhereShown = false;
  /**
   * What kind of failure saves keep meeting, so a run of failures is logged once, and a failure of
   * another kind is logged again: the file held for a moment (`busy`), or anything else.
   */
  let failing: 'busy' | 'error' | undefined;

  async function write(): Promise<void> {
    if (!unsaved) {
      return;
    }
    unsaved = false;
    try {
      const written = await data.write(progressFile, progress);
      failing = undefined;
      if (written.merged !== undefined) {
        // The file held Lessons this session could not read when the Course opened.
        progress = mergeProgress(written.merged, progress);
      }
      if (written.keptElsewhere !== undefined && !keptElsewhereShown) {
        keptElsewhereShown = true;
        logger.log({
          level: 'warn',
          message: `${written.keptElsewhere} cannot be read: keeping Progress in the extension storage.`,
        });
        ui.showMessage({
          severity: 'warning',
          text: "FollowAlong can't update this Course's progress file: it is damaged, unreadable or from a newer FollowAlong, so FollowAlong keeps your progress in its own storage for now.",
        });
      }
    } catch (error) {
      if (error instanceof UnreadableCourseDataError) {
        // Not even the fallback copy can be replaced: both stay as they are (spec #12, D5), and
        // this Course's Progress lives only for this session.
        if (!failureShown) {
          failureShown = true;
          logger.log({
            level: 'warn',
            message: `Not saving Progress: ${error.path} cannot be read.`,
          });
          ui.showMessage({
            severity: 'warning',
            text: "FollowAlong can't update this Course's progress file: it is damaged, unreadable or from a newer FollowAlong. Nothing was changed.",
          });
        }
        return;
      }
      // Not written: the next save (the 5 s timer, a pause, close()) tries again.
      unsaved = true;
      if (error instanceof CourseDataBusyError) {
        // The file is held for a moment: nothing for the learner to act on (ADR 0074).
        if (failing !== 'busy') {
          failing = 'busy';
          logger.log({ level: 'warn', message: `Progress not saved yet: ${error.message}` });
        }
        return;
      }
      const reason = FileSystemError.is(error, 'notFound')
        ? 'the Course folder is missing'
        : error instanceof Error
          ? error.message
          : String(error);
      if (failing !== 'error') {
        failing = 'error';
        logger.log({ level: 'error', message: `Could not save Progress for ${course}: ${reason}` });
      }
      if (!failureShown) {
        failureShown = true;
        ui.showMessage({
          severity: 'error',
          text: `FollowAlong could not save your Progress in “${basename(course)}”: ${reason}.`,
        });
      }
    }
  }

  /**
   * Replaces each of these Lessons' entries by hand, in memory: `change` gives the entry's fields
   * from what was there, and it is stamped after that entry (`savedAfter`).
   */
  function changeEntries(
    lessonIds: readonly string[],
    change: (before: LessonProgress | undefined, stamp: number) => LessonProgress,
  ): void {
    const lessons: Record<string, LessonProgress> = { ...progress.lessons };
    for (const lessonId of lessonIds) {
      const before = lessonEntry(lessons, lessonId);
      lessons[lessonId] = change(before, changedAfter(before, clock.now()));
    }
    progress = { ...progress, lessons };
    unsaved = true;
  }

  function resetEntries(lessonIds: readonly string[]): void {
    changeEntries(lessonIds, (_before, stamp) =>
      entryOf({ position: 0, duration: 0, savedAt: stamp }, undefined, stamp),
    );
  }

  return {
    current: () => progress,
    record(lessonId, seen) {
      const now = clock.now();
      const { position, duration } = seen;
      const before = lessonEntry(progress.lessons, lessonId);
      // After what it replaces, as every change is: the next write merges this window's own last
      // write back in, and must not let it win (a reset stamped 1 ms ahead, a clock gone back).
      const savedAt = savedAfter(before, now);
      const statusBefore = lessonStatus(progress, lessonId);
      const status = statusAfter(statusBefore, seen);
      // Play only raises a status, and the raised status keeps the stamp of the one it rose from:
      // the learner's last mark or reset, or never (0). So a mark or reset in another window this
      // one has not seen wins over it, and a reset this window made wins over a done mark the other
      // window still holds (ADR 0074).
      const statusAt = keptStatusAt(before);
      progress = {
        lessons: {
          ...progress.lessons,
          [lessonId]: entryOf(
            { position, duration, savedAt },
            status === 'notStarted' ? undefined : status,
            statusAt,
          ),
        },
        last: { lessonId, savedAt: savedAfter(progress.last, now) },
      };
      unsaved = true;
    },
    markDone(lessonIds) {
      // Only the status changes: the place stays as it was saved, so another window's newer
      // place wins the merge (ADR 0074). A Lesson with nothing saved is done at 0:00.
      changeEntries(lessonIds, (before, stamp) =>
        entryOf(before ?? { position: 0, duration: 0, savedAt: 0 }, 'done', stamp),
      );
    },
    reset: resetEntries,
    resetAll(lessonIds) {
      resetEntries([...new Set([...lessonIds, ...Object.keys(progress.lessons)])]);
      // Also when this window knows of no last Lesson: another window may have saved one.
      progress = {
        ...progress,
        last: { lessonId: noLastLesson, savedAt: savedAfter(progress.last, clock.now()) },
      };
    },
    save() {
      saving = saving.then(write);
      return saving;
    },
  };
}
