/**
 * The Resource store (spec #12, Core modules → Resource store; ADR 0012): references to files the
 * learner attaches to a Lesson, kept in `resources.json` in the Course data. A Resource is a
 * reference, never a copy. A file inside the Course is stored relative to it, so it moves with the
 * Course; any other file is stored by its absolute path.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CourseDataFile } from './course-data.js';

export interface ResourceRecord {
  readonly id: string;
  readonly kind: 'file';
  /** Relative to the Course folder, with `/` separators, or absolute. */
  readonly path: string;
  readonly relative: boolean;
}

export interface ResourcesData {
  /** The Resources of each Lesson, by the Lesson's id, in the order they were attached. */
  readonly lessons: Readonly<Record<string, readonly ResourceRecord[]>>;
}

export const noResources: ResourcesData = { lessons: {} };

function parseRecord(value: unknown): ResourceRecord | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { id, kind, path, relative: isRelative } = value as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    kind !== 'file' ||
    typeof path !== 'string' ||
    typeof isRelative !== 'boolean'
  ) {
    return undefined;
  }
  return { id, kind, path, relative: isRelative };
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
    const parsed: Record<string, readonly ResourceRecord[]> = {};
    for (const [lessonId, records] of Object.entries(lessons)) {
      if (Array.isArray(records)) {
        const valid = (records as unknown[]).flatMap((record) => parseRecord(record) ?? []);
        if (valid.length > 0) {
          parsed[lessonId] = valid;
        }
      }
    }
    return { lessons: parsed };
  },
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

export function withResource(
  data: ResourcesData,
  lessonId: string,
  record: ResourceRecord,
): ResourcesData {
  return { lessons: { ...data.lessons, [lessonId]: [...(data.lessons[lessonId] ?? []), record] } };
}
