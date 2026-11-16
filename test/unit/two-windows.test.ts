import { describe, expect, it } from 'vitest';

import { createHarness, type FakePlayer, type Harness, type OtherWindow } from './harness.js';

const intro = 'Basics/01 Intro.webm';
const setup = 'Basics/02 Setup.webm';
const closures = 'Advanced/03 Closures.webm';

/** The player plays the Lesson and reports the playhead at `position` (of a 600 s Lesson). */
function playTo(player: FakePlayer, lessonId: string, position: number): void {
  player.emit({ type: 'played', lessonId });
  player.emit({ type: 'timeUpdate', lessonId, position, duration: 600 });
}

/** The learner pauses: Progress is saved right away. */
function pause(player: FakePlayer, lessonId: string): void {
  player.emit({ type: 'paused', lessonId, byUser: true });
}

/** A Course open in two VS Code windows: the harness's window and `other`. */
async function openInTwoWindows(
  clockOffsetMs = 500,
): Promise<{ h: Harness; other: OtherWindow; course: string }> {
  const h = await createHarness();
  const course = await h.folder('course', {
    [intro]: 'video',
    [setup]: 'video',
    [closures]: 'video',
  });
  const other = h.openWindow({ clockOffsetMs });
  await h.core.openCourse(course);
  h.player.ready();
  await other.core.openCourse(course);
  other.player.ready();
  return { h, other, course };
}

/** Where each Lesson starts when the learner plays it after VS Code starts again. */
async function startsAfterRestart(
  h: Harness,
  course: string,
  lessonIds: readonly string[],
): Promise<Record<string, unknown>> {
  await h.settle();
  h.restart();
  h.clock.advance(60_000);
  await h.core.openCourse(course);
  h.player.ready();
  const starts: Record<string, unknown> = {};
  for (const lessonId of lessonIds) {
    h.core.playLesson(lessonId);
    const load = h.player.sent.findLast((command) => command.type === 'load');
    starts[lessonId] = load?.type === 'load' ? load.startAt : undefined;
  }
  return starts;
}

describe('two windows on the same Course', () => {
  it('keeps the Progress of the Lesson each window played, whichever saved last', async () => {
    const { h, other, course } = await openInTwoWindows();

    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    pause(h.player, intro);
    await h.settle();
    other.core.playLesson(setup);
    playTo(other.player, setup, 200);
    pause(other.player, setup);
    await h.settle();
    h.clock.advance(1_000);
    playTo(h.player, intro, 150);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro, setup])).toEqual({
      [intro]: 145,
      [setup]: 195,
    });
  });

  it('keeps the newer save of the same Lesson, also when the older one is written after it', async () => {
    // The other window's clock is 10 s ahead (a Course on a share, written from two machines).
    const { h, other, course } = await openInTwoWindows(10_000);

    other.core.playLesson(intro);
    playTo(other.player, intro, 300);
    pause(other.player, intro);
    await h.settle();
    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    pause(h.player, intro);

    expect(await startsAfterRestart(h, course, [intro])).toEqual({ [intro]: 295 });
  });

  it('keeps the save written later when it is also the newer one', async () => {
    const { h, other, course } = await openInTwoWindows();

    h.core.playLesson(intro);
    playTo(h.player, intro, 100);
    pause(h.player, intro);
    await h.settle();
    other.clock.advance(1_000);
    other.core.playLesson(intro);
    playTo(other.player, intro, 300);
    pause(other.player, intro);

    expect(await startsAfterRestart(h, course, [intro])).toEqual({ [intro]: 295 });
  });
});
