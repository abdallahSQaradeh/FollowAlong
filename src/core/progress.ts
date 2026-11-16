/**
 * The Progress store (spec #12, Core modules → Progress store; ADR 0010): where the learner is in
 * each Lesson of a Course, kept with the Course in `.followalong/progress.json` (or the fallback
 * storage, ADR 0005), keyed by the Lesson's path relative to the Course, so moving or renaming the
 * Course folder keeps it.
 */
import { basename } from 'node:path';

import { openCourseData, type CourseDataFile } from './course-data.js';
import { FileSystemError, type Ports } from './ports.js';

/** What is kept for one Lesson. */
export interface LessonProgress {
  /** Seconds from the start of the Lesson: where the playhead was at the last save. */
  readonly position: number;
  /** The Lesson's length in seconds, as the player last reported it (0 while unknown). */
  readonly duration: number;
  /** When this entry was saved (ms since the epoch), so the newer of two copies wins. */
  readonly savedAt: number;
}

/** The Lesson played last in the Course. */
export interface LastLesson {
  readonly lessonId: string;
  readonly savedAt: number;
}

/** Version 1 of `progress.json`'s `data`. */
export interface CourseProgress {
  /** By Lesson id (the Lesson's path in the Course, with `/`). */
  readonly lessons: Readonly<Record<string, LessonProgress>>;
  readonly last?: LastLesson;
}

/** How far before the saved position a Lesson starts again (spec #12, Resume). */
const resumeRewindSeconds = 5;

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
  const { position, duration, savedAt } = raw;
  return isSeconds(position) && isSeconds(duration) && isSeconds(savedAt)
    ? { position, duration, savedAt }
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
function entryOf(
  lessons: Readonly<Record<string, LessonProgress>>,
  lessonId: string,
): LessonProgress | undefined {
  return Object.hasOwn(lessons, lessonId) ? lessons[lessonId] : undefined;
}

/** Per Lesson, and for the last Lesson played, the entry saved later wins. */
function mergeProgress(a: CourseProgress, b: CourseProgress): CourseProgress {
  const lessons: Record<string, LessonProgress> = { ...a.lessons };
  for (const [lessonId, lesson] of Object.entries(b.lessons)) {
    const other = entryOf(lessons, lessonId);
    if (other === undefined || lesson.savedAt > other.savedAt) {
      lessons[lessonId] = lesson;
    }
  }
  const last =
    a.last === undefined || (b.last !== undefined && b.last.savedAt > a.last.savedAt)
      ? b.last
      : a.last;
  return last === undefined ? { lessons } : { lessons, last };
}

/** Where a Lesson starts when the learner comes back to it: 5 s before its saved position. */
export function resumePosition(progress: CourseProgress, lessonId: string): number {
  const saved = entryOf(progress.lessons, lessonId);
  return Math.max(0, (saved?.position ?? 0) - resumeRewindSeconds);
}

/** One open Course's Progress: read once when the Course opens, saved as the learner goes. */
export interface ProgressRecorder {
  /** What is known now, including what is not saved yet. */
  current(): CourseProgress;
  /** Notes where the playhead is in a Lesson; it is written by the next `save`. */
  record(lessonId: string, position: number, duration: number): void;
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
  const loaded = await data.load(progressFile);
  let progress: CourseProgress = loaded.value ?? { lessons: {} };
  /**
   * A copy FollowAlong cannot read (damaged, or from a newer FollowAlong) is never written over
   * (spec #12, D5): this Course's Progress is then kept only for this session.
   */
  const unreadable = loaded.unreadable;
  /** Whether something was recorded since the last write. */
  let unsaved = false;
  /** Saves run one after another, so an older one never lands after a newer one. */
  let saving: Promise<void> = Promise.resolve();
  /** The learner is told about a failing or refused save once per open Course, not every 5 s. */
  let failureShown = false;

  async function write(): Promise<void> {
    if (!unsaved) {
      return;
    }
    unsaved = false;
    if (unreadable.length > 0) {
      if (!failureShown) {
        failureShown = true;
        logger.log({
          level: 'warn',
          message: `Not saving Progress: ${unreadable.join(', ')} cannot be read.`,
        });
        ui.showMessage({
          severity: 'warning',
          text: "FollowAlong can't update this Course's progress file: it is damaged or from a newer FollowAlong. Nothing was changed.",
        });
      }
      return;
    }
    try {
      await data.write(progressFile, progress);
    } catch (error) {
      const reason = FileSystemError.is(error, 'notFound')
        ? 'the Course folder is missing'
        : error instanceof Error
          ? error.message
          : String(error);
      logger.log({ level: 'error', message: `Could not save Progress for ${course}: ${reason}` });
      if (!failureShown) {
        failureShown = true;
        ui.showMessage({
          severity: 'error',
          text: `FollowAlong could not save your Progress in “${basename(course)}”: ${reason}.`,
        });
      }
    }
  }

  return {
    current: () => progress,
    record(lessonId, position, duration) {
      const savedAt = clock.now();
      progress = {
        lessons: { ...progress.lessons, [lessonId]: { position, duration, savedAt } },
        last: { lessonId, savedAt },
      };
      unsaved = true;
    },
    save() {
      saving = saving.then(write);
      return saving;
    },
  };
}
