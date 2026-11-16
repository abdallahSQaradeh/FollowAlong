/**
 * The Resource store (spec #12, Core modules → Resource store; ADR 0012): references to files the
 * learner attaches to a Lesson, kept in `resources.json` in the Course data. A Resource is a
 * reference, never a copy. A file inside the Course is stored relative to it, so it moves with the
 * Course; any other file is stored by its absolute path.
 */
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CourseDataFile } from './course-data.js';
import type { FileSystem, ResourceTarget } from './ports.js';

export interface ResourceRecord {
  readonly id: string;
  readonly kind: 'file';
  /** Relative to the Course folder, with `/` separators, or absolute. */
  readonly path: string;
  readonly relative: boolean;
  /**
   * When the Resource was relinked (ms since the epoch); absent until it is. When two copies of
   * the file (in the Course, and in the extension storage) both hold the Resource, the later
   * relink wins (ADR 0039).
   */
  readonly changedAt?: number;
}

export interface ResourcesData {
  /** The Resources of the whole Course, in the order they were attached. */
  readonly course: readonly ResourceRecord[];
  /** The Resources of each Lesson, by the Lesson's id, in the order they were attached. */
  readonly lessons: Readonly<Record<string, readonly ResourceRecord[]>>;
  /**
   * The Resources that were detached, by id, with the time they were (ms since the epoch). Present
   * only once something was detached. It keeps an older copy of the file from bringing a detached
   * Resource back when the two copies are merged (ADR 0039).
   */
  readonly detached?: Readonly<Record<string, number>>;
}

export const noResources: ResourcesData = { course: [], lessons: {} };

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseDetached(value: unknown): Record<string, number> {
  const detached: Record<string, number> = {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [id, at] of Object.entries(value)) {
      if (isTime(at)) {
        detached[id] = at;
      }
    }
  }
  return detached;
}

/** `data`, with `detached` only when something was detached, so a file never grows a bare key. */
function withDetached(
  data: ResourcesData,
  detached: Readonly<Record<string, number>>,
): ResourcesData {
  const { course, lessons } = data;
  return Object.keys(detached).length === 0 ? { course, lessons } : { course, lessons, detached };
}

function parseRecord(value: unknown): ResourceRecord | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { id, kind, path, relative: isRelative, changedAt } = value as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    kind !== 'file' ||
    typeof path !== 'string' ||
    typeof isRelative !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    path,
    relative: isRelative,
    ...(isTime(changedAt) ? { changedAt } : {}),
  };
}

function parseRecords(value: unknown): ResourceRecord[] {
  return Array.isArray(value)
    ? (value as unknown[]).flatMap((record) => parseRecord(record) ?? [])
    : [];
}

/** The later of the two versions of a Resource: the one relinked last, `a` when neither was. */
function newer(a: ResourceRecord, b: ResourceRecord): ResourceRecord {
  return (b.changedAt ?? 0) > (a.changedAt ?? 0) ? b : a;
}

/** Every Resource of either copy, in the order of `a`'s, then the ones only `b` has. */
function unionById(
  a: readonly ResourceRecord[],
  b: readonly ResourceRecord[],
): readonly ResourceRecord[] {
  const inB = new Map(b.map((record) => [record.id, record]));
  const known = new Set(a.map((record) => record.id));
  return [
    ...a.map((record) => {
      const other = inB.get(record.id);
      return other === undefined ? record : newer(record, other);
    }),
    ...b.filter((record) => !known.has(record.id)),
  ];
}

/**
 * Both copies of the Resources file (ADR 0005, ADR 0039): per Lesson, every Resource of either
 * copy, the later relink of a Resource winning, and no Resource that was detached after it was last
 * relinked in either copy.
 */
function mergeResources(a: ResourcesData, b: ResourcesData): ResourcesData {
  const detached: Record<string, number> = { ...a.detached };
  for (const [id, at] of Object.entries(b.detached ?? {})) {
    detached[id] = Math.max(at, detached[id] ?? 0);
  }
  const alive = (records: readonly ResourceRecord[]): ResourceRecord[] =>
    records.filter((record) => {
      const at = Object.hasOwn(detached, record.id) ? detached[record.id] : undefined;
      return at === undefined || (record.changedAt ?? 0) > at;
    });
  const lessons: Record<string, readonly ResourceRecord[]> = {};
  for (const lessonId of new Set([...Object.keys(a.lessons), ...Object.keys(b.lessons)])) {
    const records = alive(
      unionById(
        Object.hasOwn(a.lessons, lessonId) ? (a.lessons[lessonId] ?? []) : [],
        Object.hasOwn(b.lessons, lessonId) ? (b.lessons[lessonId] ?? []) : [],
      ),
    );
    if (records.length > 0) {
      lessons[lessonId] = records;
    }
  }
  return withDetached({ course: alive(unionById(a.course, b.course)), lessons }, detached);
}

/** `resources.json`, version 1. A malformed Resource is dropped; a malformed file is ignored. */
export const resourcesFile: CourseDataFile<ResourcesData> = {
  name: 'resources.json',
  version: 1,
  parse(data) {
    if (typeof data !== 'object' || data === null || !('lessons' in data)) {
      return undefined;
    }
    const { lessons } = data;
    if (typeof lessons !== 'object' || lessons === null || Array.isArray(lessons)) {
      return undefined;
    }
    const course: unknown = 'course' in data ? data.course : [];
    const parsed: Record<string, readonly ResourceRecord[]> = {};
    for (const [lessonId, records] of Object.entries(lessons)) {
      if (Array.isArray(records)) {
        const valid = parseRecords(records);
        if (valid.length > 0) {
          parsed[lessonId] = valid;
        }
      }
    }
    const detached = parseDetached('detached' in data ? data.detached : undefined);
    return withDetached({ course: parseRecords(course), lessons: parsed }, detached);
  },
  merge: mergeResources,
};

/** Makes the stored reference to `absolutePath` for a Course in `courseFolder`. */
export function newResource(courseFolder: string, absolutePath: string): ResourceRecord {
  const inCourse = relative(courseFolder, absolutePath);
  const isInside = inCourse !== '' && !isAbsolute(inCourse) && inCourse.split(sep)[0] !== '..';
  return {
    id: randomUUID(),
    kind: 'file',
    path: isInside ? inCourse.split(sep).join('/') : resolve(absolutePath),
    relative: isInside,
  };
}

/** The file a Resource points to now, for a Course that may have been moved. */
export function resourcePath(courseFolder: string, record: ResourceRecord): string {
  return record.relative ? join(courseFolder, ...record.path.split('/')) : record.path;
}

/** The ids of the Resources whose file is no longer where they point (Course `folder` as opened). */
export async function missingResources(
  fileSystem: FileSystem,
  folder: string,
  data: ResourcesData,
): Promise<ReadonlySet<string>> {
  const records = [...data.course, ...Object.values(data.lessons).flat()];
  const found = await Promise.all(
    records.map(async (record) => fileSystem.exists(resourcePath(folder, record))),
  );
  return new Set(records.filter((_, index) => !found[index]).map((record) => record.id));
}

export function findResource(data: ResourcesData, id: string): ResourceRecord | undefined {
  return [...data.course, ...Object.values(data.lessons).flat()].find((record) => record.id === id);
}

export function withResource(
  data: ResourcesData,
  lessonId: string,
  record: ResourceRecord,
): ResourcesData {
  return {
    course: data.course,
    lessons: { ...data.lessons, [lessonId]: [...(data.lessons[lessonId] ?? []), record] },
  };
}

/** `data` with `record` attached to the whole Course, after the ones already there. */
export function withCourseResource(data: ResourcesData, record: ResourceRecord): ResourcesData {
  return { ...data, course: [...data.course, record] };
}

/**
 * `data` with the Resource `id` pointing where `target` points: the same Resource, in the same
 * place in its Lesson. `undefined` when `data` holds no such Resource.
 */
export function withRelinkedResource(
  data: ResourcesData,
  id: string,
  target: ResourceRecord,
  at: number,
): ResourcesData | undefined {
  if (findResource(data, id) === undefined) {
    return undefined;
  }
  const relink = (records: readonly ResourceRecord[]): ResourceRecord[] =>
    records.map((record) => (record.id === id ? { ...target, id, changedAt: at } : record));
  return {
    ...data,
    course: relink(data.course),
    lessons: Object.fromEntries(
      Object.entries(data.lessons).map(([lessonId, records]) => [lessonId, relink(records)]),
    ),
  };
}

/**
 * `data` without the Resource with this id, which it remembers as detached at time `at`, or
 * `undefined` when it holds no such Resource.
 */
export function withoutResource(
  data: ResourcesData,
  id: string,
  at: number,
): ResourcesData | undefined {
  if (findResource(data, id) === undefined) {
    return undefined;
  }
  const without = (records: readonly ResourceRecord[]): ResourceRecord[] =>
    records.filter((record) => record.id !== id);
  const lessons = Object.fromEntries(
    Object.entries(data.lessons)
      .map(([lessonId, records]) => [lessonId, without(records)] as const)
      .filter(([, records]) => records.length > 0),
  );
  return withDetached({ course: without(data.course), lessons }, { ...data.detached, [id]: at });
}

/** The opener per file type, by extension without regard to case; every other type is a file. */
const targetKinds: Readonly<Record<string, ResourceTarget['kind']>> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.avif': 'image',
  '.pdf': 'pdf',
};

/** How the file a Resource points to opens: text and code in the editor, the rest by type. */
export function resourceTarget(path: string): ResourceTarget {
  const kind = targetKinds[extname(path).toLowerCase()] ?? 'file';
  return { kind, path };
}
