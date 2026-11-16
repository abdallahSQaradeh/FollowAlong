import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const lessons = {
  '01 Intro.webm': 'video',
  '02 Setup.webm': 'video',
};
const lessonId = '01 Intro.webm';
const duration = 600;

/** What the player reports while the Lesson plays: a `timeUpdate` every second, as a 1× video. */
function playFor(h: Harness, seconds: number, from = 0): void {
  h.player.emit({ type: 'played', lessonId });
  for (let tick = 0; tick <= seconds; tick += 1) {
    h.player.emit({ type: 'timeUpdate', lessonId, position: from + tick, duration });
  }
}

function pause(h: Harness): void {
  h.player.emit({ type: 'paused', lessonId, byUser: true });
}

/** Opens `lessons` as a Course and loads its first Lesson; its player is ready. */
async function openCourse(h: Harness): Promise<string> {
  const course = await h.folder('course', lessons);
  await h.core.openCourse(course);
  h.player.ready();
  return course;
}

/** How the Course's progress file records the Lesson: `notStarted` when it has no mark. */
function savedStatus(course: string, id = lessonId): string | undefined {
  const text = readFileSync(join(course, '.followalong', 'progress.json'), 'utf8');
  const file = JSON.parse(text) as {
    data: { lessons: Record<string, { status?: string } | undefined> };
  };
  return file.data.lessons[id]?.status ?? 'notStarted';
}

describe('a Lesson is in progress after 10 s of play', () => {
  it('leaves a Lesson not started when it played for less than 10 s', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 9);
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('notStarted');
  });

  it('makes a Lesson in progress once it has played for 10 s', async () => {
    const h = await createHarness();
    const course = await openCourse(h);
    playFor(h, 10);
    pause(h);
    await h.settle();

    expect(savedStatus(course)).toBe('inProgress');
  });
});
