import { describe, expect, it } from 'vitest';

import type { StatusBarItemId, StatusBarItemModel } from '../../src/core/status-bar.js';
import { createHarness, type Harness } from './harness.js';

const lessonId = '01 Intro.webm';

/** A Course with one Lesson, open in a player that is ready; the load is already sent. */
async function openLesson(h: Harness): Promise<void> {
  const course = await h.folder('course', { [lessonId]: 'video' });
  await h.core.openCourse(course);
  h.player.ready();
}

/** The status bar item with this id, as the learner sees it now. */
function item(h: Harness, id: StatusBarItemId): StatusBarItemModel {
  const found = h.ui.statusBar.items.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`No status bar item “${id}” is shown`);
  }
  return found;
}

/** Clicks the status bar item with this id, as the learner does. */
function click(h: Harness, id: StatusBarItemId): void {
  const { command } = item(h, id);
  if (command === undefined) {
    throw new Error(`The status bar item “${id}” runs no command`);
  }
  h.core.statusBarClick(command);
}

describe('status bar items', () => {
  it('are not shown until a Lesson is loaded, and then are play/pause, time, speed and back', async () => {
    const h = await createHarness();
    expect(h.ui.statusBar.items).toEqual([]);

    await openLesson(h);

    expect(h.ui.statusBar.items.map((item) => item.id)).toEqual([
      'playPause',
      'time',
      'speed',
      'back',
    ]);
  });

  it('show play while the Lesson is paused and pause while it plays', async () => {
    const h = await createHarness();
    await openLesson(h);
    expect(item(h, 'playPause')).toMatchObject({ icon: 'play', command: 'playPause' });

    h.player.emit({ type: 'played', lessonId });
    expect(item(h, 'playPause')).toMatchObject({ icon: 'pause', command: 'playPause' });

    h.player.emit({ type: 'paused', lessonId, byUser: true });
    expect(item(h, 'playPause')).toMatchObject({ icon: 'play' });

    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'ended', lessonId });
    expect(item(h, 'playPause')).toMatchObject({ icon: 'play' });
  });

  it('show the position and length as mm:ss / mm:ss from the time updates', async () => {
    const h = await createHarness();
    await openLesson(h);
    expect(item(h, 'time').text).toBe('00:00 / --:--');

    h.player.emit({ type: 'timeUpdate', lessonId, position: 754.9, duration: 2405 });
    expect(item(h, 'time').text).toBe('12:34 / 40:05');

    // Lessons run past an hour: the minutes keep counting.
    h.player.emit({ type: 'timeUpdate', lessonId, position: 3930, duration: 5405 });
    expect(item(h, 'time').text).toBe('65:30 / 90:05');
  });

  it('ignore the time updates of a Lesson that is not the loaded one', async () => {
    const h = await createHarness();
    await openLesson(h);

    h.player.emit({ type: 'timeUpdate', lessonId: 'other.webm', position: 30, duration: 60 });

    expect(item(h, 'time').text).toBe('00:00 / --:--');
  });

  it('start again from 00:00 and play when another Lesson is loaded', async () => {
    const h = await createHarness();
    const course = await h.folder('two', { '01 A.webm': 'video', '02 B.webm': 'video' });
    await h.core.openCourse(course);
    h.player.ready();
    h.player.emit({ type: 'played', lessonId: '01 A.webm' });
    h.player.emit({ type: 'timeUpdate', lessonId: '01 A.webm', position: 90, duration: 300 });

    h.core.playLesson('02 B.webm');

    expect(item(h, 'time').text).toBe('00:00 / --:--');
    expect(item(h, 'playPause')).toMatchObject({ icon: 'play' });
  });

  it('start again from 00:00 and play when a new player page is waiting for its Lesson', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    h.player.emit({ type: 'timeUpdate', lessonId, position: 90, duration: 300 });

    // Another Course: its player page is new and takes no command until it reports ready.
    await h.core.openCourse(await h.folder('other', { '01 Other.webm': 'video' }));

    expect(item(h, 'time').text).toBe('00:00 / --:--');
    expect(item(h, 'playPause')).toMatchObject({ icon: 'play' });
  });

  it('show the speed, as the player reports it and as the speed commands set it', async () => {
    const h = await createHarness();
    await openLesson(h);
    expect(item(h, 'speed').text).toBe('1×');

    h.core.speedStep('up');
    expect(item(h, 'speed').text).toBe('1.25×');

    h.player.emit({ type: 'rateChanged', lessonId, rate: 0.75 });
    expect(item(h, 'speed').text).toBe('0.75×');
  });

  it('cycle the speed ladder when the speed item is clicked, from 2× back to 0.75×', async () => {
    const h = await createHarness();
    await openLesson(h);
    expect(item(h, 'speed').command).toBe('speedCycle');
    h.player.clearSent();

    const shown = Array.from({ length: 6 }, () => {
      click(h, 'speed');
      return item(h, 'speed').text;
    });

    expect(shown).toEqual(['1.25×', '1.5×', '2×', '0.75×', '1×', '1.25×']);
    expect(h.player.sent).toEqual(
      [1.25, 1.5, 2, 0.75, 1, 1.25].map((rate) => ({ type: 'setRate', rate })),
    );
  });

  it('cycle from a rate between rungs to the next rung up', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'rateChanged', lessonId, rate: 1.1 });
    h.player.clearSent();

    h.core.statusBarClick('speedCycle');

    expect(h.player.sent).toEqual([{ type: 'setRate', rate: 1.25 }]);
  });

  it('show 1× again on a new player page, which plays at normal speed', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.core.speedStep('up');
    h.player.close();
    await h.core.openCourse(await h.folder('other', { '01 Other.webm': 'video' }));
    h.player.ready();

    expect(item(h, 'speed').text).toBe('1×');
  });

  it('show a back item for the short step, which follows the setting', async () => {
    const h = await createHarness();
    await openLesson(h);
    expect(item(h, 'back')).toMatchObject({ icon: 'back', text: '5s', command: 'seekBackShort' });

    h.config.set('shortStep', 10);
    expect(item(h, 'back').text).toBe('10s');

    h.config.set('shortStep', 'ten');
    expect(item(h, 'back').text).toBe('5s');
  });

  it('go away when the player tab is closed, and come back when a Lesson is loaded again', async () => {
    const h = await createHarness();
    await openLesson(h);

    h.player.close();
    expect(h.ui.statusBar.items).toEqual([]);

    h.core.playLesson(lessonId);
    h.player.ready();
    expect(h.ui.statusBar.items.map((entry) => entry.id)).toEqual([
      'playPause',
      'time',
      'speed',
      'back',
    ]);
    expect(item(h, 'time').text).toBe('00:00 / --:--');
  });

  it('run the command the item names when it is clicked: play/pause and back', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.emit({ type: 'played', lessonId });
    h.player.clearSent();

    click(h, 'playPause');
    click(h, 'back');
    h.config.set('shortStep', 12);
    click(h, 'back');

    expect(h.player.sent).toEqual([
      { type: 'pause' },
      { type: 'seekBy', seconds: -5 },
      { type: 'seekBy', seconds: -12 },
    ]);
  });

  it('tell the learner no Lesson is open when a click comes after the player was closed', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.close();
    h.player.clearSent();

    h.core.statusBarClick('playPause');

    expect(h.player.sent).toEqual([]);
    expect(h.ui.messages.at(-1)?.text).toContain('no Lesson is open');
  });

  it('go away, and the commands find no Lesson, when a Course with no Lessons is opened', async () => {
    const h = await createHarness();
    await openLesson(h);
    h.player.clearSent();

    await h.core.openCourse(await h.folder('empty', { 'notes.pdf': 'pdf' }));
    h.core.playPause();
    h.core.statusBarClick('seekBackShort');
    h.core.speedStep('up');

    expect(h.ui.statusBar.items).toEqual([]);
    expect(h.player.sent).toEqual([]);
    expect(
      h.ui.messages.filter((message) => message.text.includes('no Lesson is open')),
    ).toHaveLength(3);
  });
});
