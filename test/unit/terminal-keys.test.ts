import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** Opens a Course with one Lesson, which is the first time a Lesson opens. */
async function openLesson(h: Harness, name = 'course'): Promise<void> {
  const course = await h.folder(name, { [lessonId]: 'video', '02 Next.webm': 'video' });
  await h.core.openCourse(course);
}

/** What the learner is shown to settle: let the question reach the UI, then answer it. */
async function answer(h: Harness, answered: 'accept' | 'decline' | undefined): Promise<void> {
  await flush();
  h.ui.answerQuestion(answered);
  await flush();
}

/** Lets the core's pending promises run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve();
  }
}

const onePressCommands = [
  'followalong.playPause',
  'followalong.seekBackShort',
  'followalong.seekForwardShort',
];

describe('the one-time terminal prompt', () => {
  it('asks the first time a Lesson opens whether to add the one-press commands', async () => {
    const h = await createHarness();
    await openLesson(h);
    await flush();

    expect(h.ui.questions).toHaveLength(1);
    expect(h.ui.questions[0]?.text).toContain('terminal.integrated.commandsToSkipShell');
    expect(h.terminalSettings.writes).toEqual([]);
  });

  it('does not ask again when another Lesson opens in the same session', async () => {
    const h = await createHarness();
    await openLesson(h);
    await answer(h, 'decline');
    h.core.nextLesson();
    await flush();

    expect(h.ui.questions).toHaveLength(1);
  });

  it('adds the three one-press commands to the setting when the learner agrees', async () => {
    const h = await createHarness();
    await openLesson(h);
    await answer(h, 'accept');

    expect(h.terminalSettings.value).toEqual(onePressCommands);
  });
});
