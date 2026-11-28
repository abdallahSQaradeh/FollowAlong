/**
 * The Lesson length cache (#132, ADR 0109): the length a probe found for each Lesson of the Courses
 * opened most recently, kept on this machine in the global storage so the Lesson picker shows it at
 * once and a Lesson whose file has not changed is not probed again. It lives outside the Course
 * folders and holds only what a probe can find again, so a damaged or outdated copy is ignored.
 */
import { folderKey } from './folder-identity.js';
import { messageOf } from './logger.js';
import type { FileStat, KeyValueStore, Ports } from './ports.js';

/**
 * Lesson lengths found other than by playing, in seconds, by Lesson id (ADR 0109). Never 0: the
 * Converter port reports no length rather than 0.
 */
export type LessonLengths = ReadonlyMap<string, number>;

/** Global storage key of the cache. */
const cacheKey = 'lessonLengths';

/**
 * How many Courses the cache keeps: the ones saved most recently. About 120 bytes a Lesson keeps
 * the stored value well under the size of the Course list cache.
 */
export const lessonLengthCacheCourses = 50;

/** The shape of the stored value; a different version is ignored, so the shape can grow. */
const cacheVersion = 1;

/**
 * What a probe found for one Lesson: its length in seconds, or `undefined` when ffmpeg read the
 * file but reported none ("probed, unknown"), and the file's stat at the time, so a replaced file
 * is probed again.
 */
export interface ProbedLength extends FileStat {
  readonly seconds: number | undefined;
}

/** One stored Lesson: `seconds` is `null` for "probed, unknown" (JSON has no `undefined`). */
interface StoredLesson {
  readonly size: number;
  readonly modifiedMs: number;
  readonly seconds: number | null;
}

/** One stored Course: its folder key and its Lessons by Lesson id. */
interface StoredCourse {
  readonly folder: string;
  readonly lessons: Readonly<Record<string, StoredLesson>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredLesson(value: unknown): value is StoredLesson {
  return (
    isRecord(value) &&
    typeof value.size === 'number' &&
    typeof value.modifiedMs === 'number' &&
    (value.seconds === null || typeof value.seconds === 'number')
  );
}

function isStoredCourse(value: unknown): value is StoredCourse {
  return (
    isRecord(value) &&
    typeof value.folder === 'string' &&
    isRecord(value.lessons) &&
    Object.values(value.lessons).every(isStoredLesson)
  );
}

/**
 * The stored Courses, oldest opened first; none when the stored value is not what this version
 * writes.
 */
function storedCourses(store: KeyValueStore): readonly StoredCourse[] {
  const stored: unknown = store.get(cacheKey);
  if (!isRecord(stored)) {
    return [];
  }
  const { version, courses } = stored;
  return version === cacheVersion && Array.isArray(courses) && courses.every(isStoredCourse)
    ? courses
    : [];
}

function lessonsOf(store: KeyValueStore, folder: string): Readonly<Record<string, StoredLesson>> {
  const key = folderKey(folder);
  return storedCourses(store).find((course) => course.folder === key)?.lessons ?? {};
}

/** What the cache holds for one Course, read from the global storage once. */
export interface CachedCourse {
  /**
   * The known lengths, by Lesson id, as the Lesson picker takes them. A Lesson probed with no
   * length is left out. The files are not checked here: the length job checks each one
   * ({@link CachedCourse.probed}) and saves what changed.
   */
  readonly lengths: LessonLengths;
  /**
   * What the cache holds for one Lesson whose file has this stat: `{seconds}` (`undefined` when it
   * was probed with no length), or `undefined` when it must be probed: never probed, or the file
   * changed since.
   */
  probed(lessonId: string, stat: FileStat): { readonly seconds: number | undefined } | undefined;
}

/** Reads what the cache holds for the Course in `folder`, once: later saves do not change it. */
export function cachedCourse(store: KeyValueStore, folder: string): CachedCourse {
  const lessons = new Map(Object.entries(lessonsOf(store, folder)));
  return {
    lengths: new Map(
      [...lessons].flatMap(([id, lesson]) =>
        lesson.seconds === null ? [] : [[id, lesson.seconds] as const],
      ),
    ),
    probed(lessonId, { size, modifiedMs }) {
      const lesson = lessons.get(lessonId);
      if (lesson?.size !== size || lesson.modifiedMs !== modifiedMs) {
        return undefined;
      }
      return { seconds: lesson.seconds ?? undefined };
    },
  };
}

/**
 * Adds what the probes found for Lessons of the Course in `folder` to the cache, over what it held
 * for them, and makes this Course the most recent one (with no Lessons too, so a Course opened
 * again with nothing new to probe is kept); past {@link lessonLengthCacheCourses} the oldest Course
 * is dropped. A write that fails logs one warn line and never rejects.
 */
export async function saveLessonLengths(
  ports: Pick<Ports, 'storage' | 'logger'>,
  folder: string,
  probed: ReadonlyMap<string, ProbedLength>,
): Promise<void> {
  const store = ports.storage.global;
  const key = folderKey(folder);
  // A Map, not object keys: a Lesson id is a path in the Course, whatever the learner named it.
  const merged = new Map(Object.entries(lessonsOf(store, folder)));
  for (const [id, { size, modifiedMs, seconds }] of probed) {
    merged.set(id, { size, modifiedMs, seconds: seconds ?? null });
  }
  const lessons = Object.fromEntries(merged);
  const courses = [
    ...storedCourses(store).filter((course) => course.folder !== key),
    { folder: key, lessons },
  ].slice(-lessonLengthCacheCourses);
  try {
    await store.set(cacheKey, { version: cacheVersion, courses });
  } catch (error) {
    // The cache is a convenience: a length not kept is probed again next time.
    ports.logger.log({
      level: 'warn',
      message: `Could not keep the Lesson lengths in the cache: ${messageOf(error)}`,
    });
  }
}
