/**
 * "Preparing sound… N%" and *Play without sound* (spec #12, stories 69 and 72; ticket #42): what
 * the learner is told while an MP4 Lesson's sound is prepared, and when preparing it fails. Seam 1:
 * a scripted converter and a fake clock, observed through the player's messages, the status bar and
 * the messages shown to the learner.
 */
import { describe, expect, it } from 'vitest';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

const lessonId = 'Section 1/01 Intro.mp4';

/** Opens a Course with one MP4 Lesson in a player page that cannot decode AAC. */
async function openMp4Lesson(h: Harness): Promise<void> {
  const course = await h.folder('course', { [lessonId]: 'mp4 video with AAC sound' });
  await h.core.openCourse(course);
  h.player.ready(false);
  await h.settle();
}

function ofType<T extends PlayerCommand['type']>(h: Harness, type: T) {
  return h.player.sent.filter(
    (command): command is Extract<PlayerCommand, { type: T }> => command.type === type,
  );
}

/** The status bar item that tells the learner the sound is being prepared, if it shows. */
function soundItem(h: Harness) {
  return h.ui.statusBar.items.find((item) => item.id === 'sound');
}

describe('"Preparing sound… N%"', () => {
  it('tells the player how far the sound is, from the start of the conversion to its end', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);
    const [request] = h.converter.requests;

    expect(ofType(h, 'soundProgress')).toEqual([{ type: 'soundProgress', percent: 0 }]);
    request?.progress(35);
    request?.progress(35);
    request?.progress(80);
    await request?.succeed();
    await h.settle();

    expect(ofType(h, 'soundProgress').map((command) => command.percent)).toEqual([0, 35, 80]);
    const kinds = h.player.sent
      .filter((command) => command.type === 'load' || command.type.startsWith('sound'))
      .map((command) => command.type);
    expect(kinds).toEqual([
      'load',
      'soundProgress',
      'soundProgress',
      'soundProgress',
      'soundReady',
    ]);
  });

  it('says whole percents, the same in the player and the status bar', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);

    h.converter.requests[0]?.progress(35.7);

    expect(ofType(h, 'soundProgress').at(-1)).toEqual({ type: 'soundProgress', percent: 35 });
    expect(soundItem(h)?.text).toBe('Preparing sound… 35%');
  });

  it('shows the same progress in the status bar, until the sound is ready', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);
    const [request] = h.converter.requests;

    expect(soundItem(h)?.text).toBe('Preparing sound… 0%');
    request?.progress(42);
    expect(soundItem(h)?.text).toBe('Preparing sound… 42%');
    expect(soundItem(h)?.tooltip).toContain('sound');
    await request?.succeed();
    await h.settle();

    expect(soundItem(h)).toBeUndefined();
  });

  it('tells a player page that reloaded mid-conversion where the conversion is', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);
    h.converter.requests[0]?.progress(55);

    h.player.clearSent();
    h.player.ready(false);
    await h.settle();

    expect(h.player.sent.map((command) => command.type)).toEqual(['load', 'soundProgress']);
    expect(ofType(h, 'soundProgress')).toEqual([{ type: 'soundProgress', percent: 55 }]);
    expect(h.converter.requests).toHaveLength(1);
  });

  it('shows nothing for a Lesson whose sound is already prepared, or needs none', async () => {
    const h = await createHarness();
    h.converter.audioCodec = undefined;
    await openMp4Lesson(h);

    expect(ofType(h, 'soundProgress')).toEqual([]);
    expect(soundItem(h)).toBeUndefined();
  });

  it('takes the status bar message away when the learner moves on to another Lesson', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '01 Intro.mp4': 'first mp4',
      '02 Setup.mp4': 'second mp4',
    });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();
    h.converter.requests[0]?.progress(30);

    h.core.nextLesson();
    await h.settle();
    h.converter.requests[0]?.progress(60);

    // The second Lesson's own conversion shows; the first one's late progress does not.
    expect(soundItem(h)?.text).toBe('Preparing sound… 0%');
    expect(ofType(h, 'soundProgress').map((command) => command.percent)).toEqual([0, 30, 0]);
  });
});

describe('Play without sound', () => {
  it('sends one error to the player instead of a message box, and the status bar message goes', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);
    h.converter.requests[0]?.progress(20);

    h.converter.requests[0]?.fail('ffmpeg exited with code 1');
    await h.settle();

    expect(ofType(h, 'soundFailed')).toEqual([
      { type: 'soundFailed', message: 'ffmpeg exited with code 1' },
    ]);
    expect(h.ui.messages).toEqual([]);
    expect(soundItem(h)).toBeUndefined();
    expect(ofType(h, 'soundReady')).toEqual([]);
  });

  it('shows the error again on a player page that reloads, and does not convert again', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);
    h.converter.requests[0]?.fail('ffmpeg exited with code 1');
    await h.settle();

    h.player.ready(false);
    await h.settle();

    expect(ofType(h, 'soundFailed')).toHaveLength(2);
    expect(h.converter.requests).toHaveLength(1);
    expect(h.ui.messages).toEqual([]);
  });

  it('lets a reloaded page play without sound once the learner chose to, without the error again', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);
    h.converter.requests[0]?.fail('ffmpeg exited with code 1');
    await h.settle();
    h.player.emit({ type: 'playWithoutSound', lessonId });

    h.player.clearSent();
    h.player.ready(false);
    await h.settle();

    expect(ofType(h, 'soundFailed')).toEqual([]);
    expect(ofType(h, 'noSidecar')).toHaveLength(1);
  });

  it('tries the sound again when the learner opens the Lesson again later', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '01 Intro.mp4': 'first mp4',
      '02 Setup.mp4': 'second mp4',
    });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();
    h.converter.requests[0]?.fail('ffmpeg exited with code 1');
    await h.settle();
    h.player.emit({ type: 'playWithoutSound', lessonId: '01 Intro.mp4' });

    h.core.nextLesson();
    await h.settle();
    h.core.previousLesson();
    await h.settle();

    expect(h.converter.requests).toHaveLength(3);
    expect(ofType(h, 'soundFailed')).toHaveLength(1);
  });

  it('ignores a choice about a Lesson that is not the loaded one', async () => {
    const h = await createHarness();
    await openMp4Lesson(h);
    h.converter.requests[0]?.fail('ffmpeg exited with code 1');
    await h.settle();
    h.player.emit({ type: 'playWithoutSound', lessonId: 'Other/99 Elsewhere.mp4' });

    h.player.clearSent();
    h.player.ready(false);
    await h.settle();

    expect(ofType(h, 'soundFailed')).toHaveLength(1);
  });
});
