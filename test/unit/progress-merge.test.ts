/**
 * The merge of two copies of `progress.json` (ADR 0074, D14 on #12), over every combination of a
 * small domain. Two windows (or `.followalong` and the fallback storage) hold copies, and the Course
 * data store merges them in whatever order and grouping the writes happen in, so the merge must not
 * depend on either: commutative, associative and idempotent. `progressFile.merge` is the Course data
 * file's public contract that the store calls (ADR 0005); this test drives it directly because a
 * file per combination (over 100 000 triples) would be far slower and check nothing more.
 */
import { describe, expect, it } from 'vitest';

import {
  progressFile,
  type CourseProgress,
  type LastLesson,
  type LessonProgress,
} from '../../src/core/progress.js';

const lessonId = 'Section 1/01 Intro.webm';

type Status = LessonProgress['status'];

/** Every entry of the domain: status × statusAt (or none written) × savedAt × position. */
const entries: readonly LessonProgress[] = (() => {
  const statuses: readonly Status[] = [undefined, 'inProgress', 'done'];
  const stamps: readonly (number | undefined)[] = [undefined, 0, 1_000, 2_000];
  const all: LessonProgress[] = [];
  for (const status of statuses) {
    for (const statusAt of stamps) {
      for (const savedAt of [1_500, 2_500]) {
        for (const position of [10, 20]) {
          all.push({
            position,
            duration: 600,
            savedAt,
            ...(status === undefined ? {} : { status }),
            ...(statusAt === undefined ? {} : { statusAt }),
          });
        }
      }
    }
  }
  return all;
})();

const lasts: readonly (LastLesson | undefined)[] = [
  undefined,
  { lessonId: 'a.webm', savedAt: 100 },
  { lessonId: 'b.webm', savedAt: 100 },
  { lessonId: 'a.webm', savedAt: 200 },
];

function merge(a: CourseProgress, b: CourseProgress): CourseProgress {
  const merged = progressFile.merge?.(a, b);
  if (merged === undefined) {
    throw new Error('progress.json has no merge');
  }
  return merged;
}

function copy(entry: LessonProgress, last?: LastLesson): CourseProgress {
  return last === undefined
    ? { lessons: { [lessonId]: entry } }
    : { lessons: { [lessonId]: entry }, last };
}

/**
 * What an entry means, in the terms of the file format (ADR 0074): a `statusAt` that is not written
 * is the entry's `savedAt`. Two entries that mean the same are the same copy.
 */
function meaning(progress: CourseProgress): unknown {
  const entry = progress.lessons[lessonId];
  return {
    lesson:
      entry === undefined
        ? undefined
        : {
            position: entry.position,
            duration: entry.duration,
            savedAt: entry.savedAt,
            status: entry.status ?? 'none',
            statusAt: entry.statusAt ?? entry.savedAt,
          },
    last: progress.last,
  };
}

const rank = { none: 0, inProgress: 1, done: 2 } as const;

/** D14, as the spec states it, for one pair of entries. */
function expectedStatus(
  a: LessonProgress,
  b: LessonProgress,
): { status: string; statusAt: number } {
  const of = (entry: LessonProgress) => ({
    status: entry.status ?? 'none',
    statusAt: entry.statusAt ?? entry.savedAt,
  });
  const [x, y] = [of(a), of(b)];
  if (x.statusAt !== y.statusAt) {
    // A newer status set by hand always wins.
    return x.statusAt > y.statusAt ? x : y;
  }
  // Equal stamps: both rose by play from the same baseline, and play only raises.
  return rank[x.status as keyof typeof rank] >= rank[y.status as keyof typeof rank] ? x : y;
}

describe('merging two copies of a Lesson’s Progress (D14)', () => {
  it('takes the status set by hand later, and the higher status on a tie, in either order', () => {
    const failures: string[] = [];
    for (const a of entries) {
      for (const b of entries) {
        const merged = meaning(merge(copy(a), copy(b))) as {
          lesson: { status: string; statusAt: number; savedAt: number };
        };
        const want = expectedStatus(a, b);
        const newestSave = Math.max(a.savedAt, b.savedAt);
        if (
          merged.lesson.status !== want.status ||
          merged.lesson.statusAt !== want.statusAt ||
          merged.lesson.savedAt !== newestSave
        ) {
          failures.push(`${JSON.stringify(a)} + ${JSON.stringify(b)} → ${JSON.stringify(merged)}`);
        }
      }
    }
    expect(failures.slice(0, 5), `${String(failures.length)} pairs break D14`).toEqual([]);
  });

  it('is commutative', () => {
    const failures: string[] = [];
    for (const a of entries) {
      for (const b of entries) {
        for (const [lastA, lastB] of lasts.flatMap((x) => lasts.map((y) => [x, y] as const))) {
          const ab = meaning(merge(copy(a, lastA), copy(b, lastB)));
          const ba = meaning(merge(copy(b, lastB), copy(a, lastA)));
          if (JSON.stringify(ab) !== JSON.stringify(ba)) {
            failures.push(`${JSON.stringify([a, lastA])} / ${JSON.stringify([b, lastB])}`);
          }
        }
      }
    }
    expect(failures.slice(0, 5), `${String(failures.length)} pairs depend on order`).toEqual([]);
  });

  it('is idempotent: a copy merged with itself is that copy', () => {
    for (const a of entries) {
      for (const last of lasts) {
        expect(meaning(merge(copy(a, last), copy(a, last)))).toEqual(meaning(copy(a, last)));
      }
    }
  });

  it('is associative over every triple', () => {
    let failures = 0;
    let example = '';
    for (const a of entries) {
      for (const b of entries) {
        for (const c of entries) {
          const left = JSON.stringify(meaning(merge(merge(copy(a), copy(b)), copy(c))));
          const right = JSON.stringify(meaning(merge(copy(a), merge(copy(b), copy(c)))));
          if (left !== right) {
            failures += 1;
            example ||= `${JSON.stringify([a, b, c])}: ${left} ≠ ${right}`;
          }
        }
      }
    }
    expect({ failures, example }).toEqual({ failures: 0, example: '' });
  });
});
