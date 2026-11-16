import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const lessons = {
  '01 Intro.webm': 'video',
  '02 Setup.webm': 'video',
  '03 Closures.webm': 'video',
};

/** The player plays the current Lesson, reporting the playhead at `position` (of a 600 s Lesson). */
function playTo(h: Harness, lessonId: string, position: number): void {
  h.player.emit({ type: 'played', lessonId });
  h.player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
}

function pause(h: Harness, lessonId: string): void {
  h.player.emit({ type: 'paused', lessonId, byUser: true });
}

/** VS Code starts again and the learner opens the Course; returns the `load` the player gets. */
async function reopen(h: Harness, course: string) {
  await h.settle();
  h.restart();
  await h.core.openCourse(course);
  h.player.ready();
  return h.player.sent.at(-1);
}

describe('remembering where the learner is in each Lesson', () => {
  it('reopens the Course on the last Lesson played, paused 5 s before where the learner paused', async () => {
    const h = await createHarness();
    const course = await h.folder('course', lessons);
    await h.core.openCourse(course);
    h.player.ready();
    h.core.playLesson('02 Setup.webm');
    playTo(h, '02 Setup.webm', 42.5);
    pause(h, '02 Setup.webm');

    expect(await reopen(h, course)).toEqual({
      type: 'load',
      lessonId: '02 Setup.webm',
      videoUri: h.player.resourceUri(join(course, '02 Setup.webm')),
      container: 'webm',
      startAt: 37.5,
      autoplay: false,
    });
  });
});
