/**
 * Two windows on one Course, every interleaving of what the learner can do to one Lesson's status
 * (ADR 0074, D14 on #12), up to {@link depth} steps. Each step is one of:
 * - mark the Lesson done or not done by hand (saved at once);
 * - play it past its 10 s (not saved yet);
 * - play it to its end (saved at once);
 * - pause (saves what was recorded).
 * Then both windows close, a third opens the Course, and the tree's glyph must be what the rule
 * says. The rule's model below follows what each window knows, which is only what it read when it
 * opened the Course and when it last wrote, and the merge D14 states.
 */
import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness, type OtherWindow } from './harness.js';

const intro = '01 Intro.webm';
/** Every sequence of up to this many steps is tried. */
const depth = 3;

type WindowName = 'A' | 'B';
type Kind = 'done' | 'reset' | 'play' | 'end' | 'save';
interface Step {
  readonly window: WindowName;
  readonly kind: Kind;
}

const steps: readonly Step[] = (['A', 'B'] as const).flatMap((window) =>
  (['done', 'reset', 'play', 'end', 'save'] as const).map((kind) => ({ window, kind })),
);

function sequences(length: number): Step[][] {
  if (length === 0) {
    return [[]];
  }
  return sequences(length - 1).flatMap((before) => steps.map((step) => [...before, step]));
}

// --- The rule's model ----------------------------------------------------------------------------

/** none < in progress < done, and the time the status was last set by hand (0: never). */
interface Known {
  readonly status: 0 | 1 | 2;
  readonly setAt: number;
}

/** D14: the status set by hand later wins; on equal stamps, the higher status. */
function merged(a: Known, b: Known): Known {
  if (a.setAt !== b.setAt) {
    return a.setAt > b.setAt ? a : b;
  }
  return a.status >= b.status ? a : b;
}

function expectedStatus(sequence: readonly Step[]): 0 | 1 | 2 {
  let file: Known = { status: 0, setAt: 0 };
  const known: Record<WindowName, Known> = { A: file, B: file };
  const unsaved: Record<WindowName, boolean> = { A: false, B: false };
  const save = (window: WindowName): void => {
    if (unsaved[window]) {
      file = merged(known[window], file);
      known[window] = file;
      unsaved[window] = false;
    }
  };
  sequence.forEach(({ window, kind }, index) => {
    const time = index + 1;
    switch (kind) {
      case 'done':
      case 'reset':
        known[window] = { status: kind === 'done' ? 2 : 0, setAt: time };
        unsaved[window] = true;
        save(window);
        break;
      case 'play':
        known[window] = { ...known[window], status: known[window].status === 2 ? 2 : 1 };
        unsaved[window] = true;
        break;
      case 'end':
        known[window] = { ...known[window], status: 2 };
        unsaved[window] = true;
        save(window);
        break;
      case 'save':
        save(window);
        break;
    }
  });
  save('A');
  save('B');
  return file.status;
}

// --- The two windows -----------------------------------------------------------------------------

const glyphOf = { 0: '○', 1: '◐', 2: '✓' } as const;

function glyph(window: OtherWindow): string | undefined {
  const lesson = (window.ui.lessonTree?.nodes ?? []).find(
    (node): node is Extract<LessonTreeNode, { kind: 'lesson' }> => node.kind === 'lesson',
  );
  return lesson?.glyph;
}

async function play(h: Harness, sequence: readonly Step[], index: number): Promise<string> {
  const course = await h.folder(`course-${String(index)}`, { [intro]: 'video' });
  const windows = { A: h.openWindow(), B: h.openWindow() };
  for (const window of Object.values(windows)) {
    await window.core.openCourse(course);
    window.player.ready();
  }
  const plays: Record<WindowName, number> = { A: 0, B: 0 };
  for (const { window: name, kind } of sequence) {
    // Each step comes later than the one before, by the clocks of both windows.
    for (const window of Object.values(windows)) {
      window.clock.advance(100);
    }
    const { core, player } = windows[name];
    switch (kind) {
      case 'done':
        await core.markLessonDone(intro);
        break;
      case 'reset':
        await core.markLessonNotDone(intro);
        break;
      case 'play': {
        // 22 s of play, away from the Lesson's last 5 %.
        const from = 100 + 30 * plays[name];
        plays[name] += 1;
        player.emit({ type: 'played', lessonId: intro });
        for (let position = from; position <= from + 22; position += 2) {
          player.emit({ type: 'timeUpdate', lessonId: intro, position, duration: 600 });
        }
        break;
      }
      case 'end':
        player.emit({ type: 'played', lessonId: intro });
        player.emit({ type: 'timeUpdate', lessonId: intro, position: 600, duration: 600 });
        player.emit({ type: 'ended', lessonId: intro });
        break;
      case 'save':
        player.emit({ type: 'paused', lessonId: intro, byUser: true });
        break;
    }
    await h.settle();
  }
  await windows.A.core.close();
  await windows.B.core.close();
  const reader = h.openWindow();
  await reader.core.openCourse(course);
  return glyph(reader) ?? 'no Lesson';
}

describe('two windows changing one Lesson’s status in every order (D14)', () => {
  it(`ends with the status the rule gives, for every sequence of up to ${String(depth)} steps`, async () => {
    const h = await createHarness();
    const all = Array.from({ length: depth + 1 }, (_, length) => sequences(length)).flat();
    const failures: string[] = [];
    for (const [index, sequence] of all.entries()) {
      const shown = await play(h, sequence, index);
      const expected = glyphOf[expectedStatus(sequence)];
      if (shown !== expected) {
        failures.push(
          `${sequence.map((step) => `${step.window}:${step.kind}`).join(' ')} → ${shown}, expected ${expected}`,
        );
      }
    }
    expect({
      sequences: all.length,
      failures: failures.length,
      first: failures.slice(0, 8),
    }).toEqual({ sequences: all.length, failures: 0, first: [] });
  }, 120_000);
});
