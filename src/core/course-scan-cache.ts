/**
 * The scan cache (spec #12, Core modules → Course scanner; ADR 0058): the Courses the last scan
 * found, kept on this machine in the global storage so the Course picker opens from it at once
 * and rescans in the background. It lives outside the Course folders, and holds only what a scan
 * can find again, so a damaged or outdated copy is ignored, never repaired.
 */
import { scanCourses, type CourseScan, type ScannedCourse } from './course-scanner.js';
import { keyOf } from './courses-roots.js';
import type { KeyValueStore, Ports } from './ports.js';

/** Global storage key of the cache. */
const cacheKey = 'courseScanCache';

/** The shape of the stored value; a different version is ignored, so the shape can grow. */
const cacheVersion = 1;

/** The same roots, in the same order: the order decides which root files a Course found twice. */
function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((root, index) => keyOf(root) === keyOf(b[index] ?? ''));
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isScannedCourse(value: unknown): value is ScannedCourse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const course = value as Partial<Record<keyof ScannedCourse, unknown>>;
  return (
    typeof course.name === 'string' &&
    typeof course.folder === 'string' &&
    course.folder !== '' &&
    isStrings(course.categories)
  );
}

/**
 * The Courses the last scan of exactly these Courses roots found, or `undefined` when there is
 * none: never scanned, other roots (a root was added or removed), or a stored value that is not
 * what this version writes.
 */
export function readScanCache(
  store: KeyValueStore,
  roots: readonly string[],
): readonly ScannedCourse[] | undefined {
  const stored: unknown = store.get(cacheKey);
  if (typeof stored !== 'object' || stored === null) {
    return undefined;
  }
  const { version, roots: storedRoots, courses } = stored as Record<string, unknown>;
  return version === cacheVersion &&
    isStrings(storedRoots) &&
    sameRoots(storedRoots, roots) &&
    Array.isArray(courses) &&
    courses.every(isScannedCourse)
    ? courses
    : undefined;
}

/** Replaces the cache with what a scan of these Courses roots found. */
export async function writeScanCache(
  store: KeyValueStore,
  roots: readonly string[],
  courses: readonly ScannedCourse[],
): Promise<void> {
  await store.set(cacheKey, { version: cacheVersion, roots, courses });
}

/** What the Course picker needs of the scan: the cache, and a scan that fills it. */
export interface CourseScans {
  /** The Courses the last scan of exactly these roots found, if the cache holds them. */
  cached(roots: readonly string[]): readonly ScannedCourse[] | undefined;
  /**
   * Scans the Courses roots and keeps the result in the cache. Without `fresh` it joins a scan of
   * the same roots that is already running (a picker opened again before the last scan was done
   * does not walk the library twice); `fresh` always starts a new one (Refresh). A scan that a
   * later one has overtaken is not cached, so an older walk never replaces a newer one.
   */
  scan(
    roots: readonly string[],
    knownFolders: readonly string[],
    options?: { readonly fresh: boolean },
  ): Promise<CourseScan>;
}

export function createCourseScans(
  ports: Pick<Ports, 'fileSystem' | 'storage' | 'logger'>,
): CourseScans {
  let started = 0;
  let running:
    { readonly roots: readonly string[]; readonly promise: Promise<CourseScan> } | undefined;
  return {
    cached: (roots) => readScanCache(ports.storage.global, roots),
    scan(roots, knownFolders, options) {
      if (options?.fresh !== true && running !== undefined && sameRoots(running.roots, roots)) {
        return running.promise;
      }
      started += 1;
      const mine = started;
      const promise: Promise<CourseScan> = scanCourses(ports, roots, knownFolders)
        .then(async (scan) => {
          if (mine === started) {
            try {
              await writeScanCache(ports.storage.global, roots, scan.courses);
            } catch (error) {
              // The cache is a convenience: the picker has the scan either way.
              ports.logger.log({
                level: 'warn',
                message: `Could not keep the Course list in the cache: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
          return scan;
        })
        .finally(() => {
          if (running?.promise === promise) {
            running = undefined;
          }
        });
      running = { roots, promise };
      return promise;
    },
  };
}
