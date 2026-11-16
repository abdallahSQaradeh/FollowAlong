import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LessonTreeNode } from '../../src/core/lesson-tree.js';
import { createHarness, type Harness } from './harness.js';

/** The labels of the Resources shown under a Lesson of the tree the learner sees. */
function resourceLabels(h: Harness, lessonId: string): string[] {
  const labels: string[] = [];
  const walk = (nodes: readonly LessonTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'section') {
        walk(node.children);
      } else if (node.kind === 'lesson' && node.id === lessonId) {
        labels.push(...node.resources.map((resource) => resource.label));
      }
    }
  };
  walk(h.ui.lessonTree?.nodes ?? []);
  return labels;
}

/** A Course of two Lessons, the first one playing in a ready player, and a file to attach. */
async function playingFirstLesson(): Promise<{ h: Harness; notes: string }> {
  const h = await createHarness();
  const course = await h.folder('course', { '01 One.webm': 'v', '02 Two.webm': 'v' });
  const notes = join(course, 'notes.md');
  await writeFile(notes, '# notes');
  await h.core.openCourse(course);
  h.player.ready();
  h.player.emit({ type: 'played', lessonId: '01 One.webm' });
  return { h, notes };
}

describe('attaching a Resource from the chord', () => {
  it('asks for a file and attaches it to the Loaded Lesson', async () => {
    const { h, notes } = await playingFirstLesson();

    h.ui.willChoose('File…');
    const attached = h.core.attachToLoadedLesson();
    await h.ui.fileDialogShown();
    expect(h.ui.fileDialogOpen).toBe(true);
    h.ui.answerFileDialog(notes);
    await attached;

    expect(resourceLabels(h, '01 One.webm')).toEqual(['notes.md']);
    expect(resourceLabels(h, '02 Two.webm')).toEqual([]);
  });

  it('attaches to the Loaded Lesson, after the learner moved on', async () => {
    const { h, notes } = await playingFirstLesson();
    h.core.nextLesson();
    h.player.ready();

    h.ui.willChoose('File…');
    const attached = h.core.attachToLoadedLesson();
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(notes);
    await attached;

    expect(resourceLabels(h, '01 One.webm')).toEqual([]);
    expect(resourceLabels(h, '02 Two.webm')).toEqual(['notes.md']);
  });

  it('keeps the Lesson that was playing when the chord was pressed, if another starts meanwhile', async () => {
    const { h, notes } = await playingFirstLesson();

    h.ui.willChoose('File…');
    const attached = h.core.attachToLoadedLesson();
    h.core.nextLesson();
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(notes);
    await attached;

    expect(resourceLabels(h, '01 One.webm')).toEqual(['notes.md']);
    expect(resourceLabels(h, '02 Two.webm')).toEqual([]);
  });

  it('attaches to the Lesson of the Course it was pressed in, if another Course opens meanwhile', async () => {
    const { h, notes } = await playingFirstLesson();
    const other = await h.folder('other', { '01 One.webm': 'v' });

    h.ui.willChoose('File…');
    const attached = h.core.attachToLoadedLesson();
    await h.core.openCourse(other);
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(notes);
    await attached;

    expect(resourceLabels(h, '01 One.webm')).toEqual([]);
    // The tree shows the other Course, so the learner is told where the Resource went.
    expect(h.ui.messages).toContainEqual({
      severity: 'info',
      text: 'FollowAlong attached “notes.md” to “One” in “course”, which is no longer open.',
    });
    await h.core.openCourse(join(notes, '..'));
    expect(resourceLabels(h, '01 One.webm')).toEqual(['notes.md']);
  });

  it('never pauses or otherwise commands the player', async () => {
    const { h, notes } = await playingFirstLesson();
    h.player.clearSent();

    h.ui.willChoose('File…');
    const attached = h.core.attachToLoadedLesson();
    expect(h.player.sent).toEqual([]);
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(notes);
    await attached;

    expect(h.player.sent).toEqual([]);
  });

  it('hands focus back to the code once the dialog closes, with or without a file', async () => {
    const { h, notes } = await playingFirstLesson();

    h.ui.willChoose('File…');
    const first = h.core.attachToLoadedLesson();
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(notes);
    await first;
    expect(h.ui.focusReturns).toBe(1);

    h.ui.willChoose('File…');
    const second = h.core.attachToLoadedLesson();
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(undefined);
    await second;
    expect(h.ui.focusReturns).toBe(2);
    expect(resourceLabels(h, '01 One.webm')).toEqual(['notes.md']);
  });

  it('tells the learner to open a Lesson first when none is loaded, and opens no dialog', async () => {
    const h = await createHarness();

    h.ui.willChoose('File…');
    await h.core.attachToLoadedLesson();

    expect(h.ui.fileDialogs).toBe(0);
    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'Open a Lesson first, then attach a Resource to it.' },
    ]);
  });

  it('leaves a damaged Resources file as it is, tells the learner, and still hands focus back', async () => {
    const { h, notes } = await playingFirstLesson();
    const file = join(join(notes, '..'), '.followalong', 'resources.json');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '{ not json');

    h.ui.willChoose('File…');
    const attached = h.core.attachToLoadedLesson();
    await h.ui.fileDialogShown();
    h.ui.answerFileDialog(notes);
    await attached;

    expect(await readFile(file, 'utf8')).toBe('{ not json');
    expect(h.ui.messages.map((message) => message.severity)).toEqual(['warning']);
    expect(h.ui.focusReturns).toBe(1);
  });
});
