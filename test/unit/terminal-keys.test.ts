import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFollowAlong } from '../../src/core/follow-along.js';
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
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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

  it('keeps the entries the learner already has, and adds the commands after them', async () => {
    const h = await createHarness();
    h.terminalSettings.value = ['workbench.action.quickOpen', '-workbench.action.togglePanel'];
    await openLesson(h);
    await answer(h, 'accept');

    expect(h.terminalSettings.value).toEqual([
      'workbench.action.quickOpen',
      '-workbench.action.togglePanel',
      ...onePressCommands,
    ]);
  });

  it('does not duplicate a command the learner already has', async () => {
    const h = await createHarness();
    h.terminalSettings.value = ['followalong.seekBackShort', 'workbench.action.quickOpen'];
    await openLesson(h);
    await answer(h, 'accept');

    expect(h.terminalSettings.value).toEqual([
      'followalong.seekBackShort',
      'workbench.action.quickOpen',
      'followalong.playPause',
      'followalong.seekForwardShort',
    ]);
  });

  it('writes nothing when the learner already has all three commands', async () => {
    const h = await createHarness();
    h.terminalSettings.value = [...onePressCommands];
    await openLesson(h);
    await answer(h, 'accept');

    expect(h.terminalSettings.writes).toEqual([]);
  });

  it('leaves a value it cannot read as a list of commands as it is, and says so', async () => {
    const h = await createHarness();
    h.terminalSettings.value = 'workbench.action.quickOpen';
    await openLesson(h);
    await answer(h, 'accept');

    expect(h.terminalSettings.writes).toEqual([]);
    expect(h.terminalSettings.value).toBe('workbench.action.quickOpen');
    expect(h.ui.messages.map((message) => message.severity)).toEqual(['warning']);
  });

  it('remembers a decline for good: a restarted core does not ask again, and writes nothing', async () => {
    const h = await createHarness();
    await openLesson(h);
    await answer(h, 'decline');
    const restarted = createFollowAlong(h.ports);
    await restarted.openCourse(await h.folder('second', { 'a.webm': 'video' }));
    await flush();
    restarted.dispose();

    expect(h.ui.questions).toHaveLength(1);
    expect(h.terminalSettings.writes).toEqual([]);
  });

  it('does not ask again in the same window after the learner closed the question', async () => {
    const h = await createHarness();
    await openLesson(h);
    await answer(h, undefined);
    h.core.nextLesson();
    h.core.previousLesson();
    await flush();

    expect(h.ui.questions).toHaveLength(1);
  });

  it('asks again in the next window when the learner closed the question without answering', async () => {
    const h = await createHarness();
    await openLesson(h);
    await answer(h, undefined);
    const nextWindow = createFollowAlong(h.ports);
    await nextWindow.openCourse(await h.folder('second', { 'a.webm': 'video' }));
    await flush();
    nextWindow.dispose();

    expect(h.ui.questions).toHaveLength(2);
  });

  it('keeps one question open when more Lessons open before it is answered', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.core.nextLesson();
    h.core.previousLesson();
    await flush();

    expect(h.ui.questions).toHaveLength(1);
  });

  it('tells the learner when the setting could not be saved, and does not ask again', async () => {
    const h = await createHarness();
    h.terminalSettings.writeFailure = 'settings.json is read-only';
    await openLesson(h);
    await answer(h, 'accept');
    h.core.nextLesson();
    await flush();

    expect(h.ui.messages.map((message) => message.severity)).toEqual(['error']);
    expect(h.ui.questions).toHaveLength(1);
  });
});

describe('the keys the prompt is about', () => {
  it('are exactly the commands the manifest binds to a one-press key, not a chord', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as {
      contributes: { keybindings: { command: string; key: string }[] };
    };
    const onePress = manifest.contributes.keybindings
      .filter(({ key }) => !key.includes(' '))
      .map(({ command }) => command);

    expect([...new Set(onePress)].sort()).toEqual([...onePressCommands].sort());
  });
});
