/**
 * The audio sidecar service (spec #12, Sound for MP4 Lessons; ticket #41): VS Code cannot decode
 * AAC, so an MP4 Lesson's sound is converted to MP3 and played beside the video.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';
import { makeReadOnly } from './read-only.js';

const lessonId = 'Section 1/01 Intro.mp4';

/** Opens a Course with one MP4 Lesson in a player that reports whether AAC plays. */
async function openMp4Lesson(h: Harness, aacSupported: boolean, name = 'course'): Promise<string> {
  const course = await h.folder(name, { [lessonId]: 'mp4 video with AAC sound' });
  await h.core.openCourse(course);
  h.player.ready(aacSupported);
  await h.settle();
  return course;
}

function soundCommands(h: Harness): PlayerCommand[] {
  return h.player.sent.filter((command) => command.type === 'soundReady');
}

describe('sound for MP4 Lessons', () => {
  it('converts the sound of the opened MP4 Lesson when AAC does not play, and sends it once ready', async () => {
    const h = await createHarness();
    const course = await openMp4Lesson(h, false);

    expect(h.converter.requests).toHaveLength(1);
    const { request } = h.converter.requests[0] ?? {};
    expect(request?.input).toBe(join(course, 'Section 1', '01 Intro.mp4'));
    expect(dirname(request?.output ?? '')).toBe(join(course, '.followalong', 'sound'));
    expect(request?.output.endsWith('.mp3')).toBe(true);
    expect(soundCommands(h)).toEqual([]);

    await h.converter.requests[0]?.succeed();
    await h.settle();

    expect(soundCommands(h)).toEqual([
      { type: 'soundReady', audioUri: h.player.resourceUri(request?.output ?? '') },
    ]);
  });

  it('plays an MP4 Lesson with its own sound when AAC plays, and never converts it', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, true);

    expect(h.converter.requests).toEqual([]);
    expect(soundCommands(h)).toEqual([]);
    expect(h.player.sent.filter((command) => command.type === 'load')).toHaveLength(1);
  });

  it('never converts a WebM Lesson, which plays with its own sound', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { '01 Intro.webm': 'webm video' });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();

    expect(h.converter.requests).toEqual([]);
    expect(soundCommands(h)).toEqual([]);
  });

  it('reuses the sound it prepared when the Lesson is opened again', async () => {
    const h = await createHarness();
    const course = await openMp4Lesson(h, false);
    await h.converter.requests[0]?.succeed();
    await h.settle();
    const first = soundCommands(h);

    await h.core.close();
    h.restart();
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();

    expect(h.converter.requests).toHaveLength(1);
    expect(soundCommands(h)).toEqual(first);
    expect(await h.listFiles(join(course, '.followalong', 'sound'))).toHaveLength(1);
  });

  it('converts the sound again when the Lesson file changed on disk', async () => {
    const h = await createHarness();
    const course = await openMp4Lesson(h, false);
    await h.converter.requests[0]?.succeed();
    await h.settle();

    await h.core.close();
    await writeFile(join(course, 'Section 1', '01 Intro.mp4'), 'a re-downloaded, longer mp4 video');
    h.restart();
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();

    expect(h.converter.requests).toHaveLength(2);
    expect(h.converter.requests[1]?.request.output).not.toBe(
      h.converter.requests[0]?.request.output,
    );
  });

  it('keeps the sound in its own storage when the Course folder is read-only', async () => {
    const h = await createHarness();
    const course = await h.folder('course', { [lessonId]: 'mp4 video with AAC sound' });
    makeReadOnly(course);
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();

    const output = h.converter.requests[0]?.request.output ?? '';
    expect(output.startsWith(join(h.storage.folder, 'courses'))).toBe(true);
    await h.converter.requests[0]?.succeed();
    await h.settle();

    expect(soundCommands(h)).toEqual([
      { type: 'soundReady', audioUri: h.player.resourceUri(output) },
    ]);
    expect(await h.listFiles(course)).toEqual([lessonId]);
    expect(h.ui.messages.filter((message) => message.severity !== 'info')).toEqual([]);
  });

  it('runs the ffmpeg on PATH, or the one the followalong.ffmpegPath setting names', async () => {
    const h = await createHarness();
    // A full path on the machine the tests run on, as the learner's own ffmpeg would be.
    const own = join(h.root, 'Tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
    await openMp4Lesson(h, false, 'first');
    h.config.set('ffmpegPath', own);
    await openMp4Lesson(h, false, 'second');

    expect(h.converter.requests.map(({ request }) => request.program)).toEqual(['ffmpeg', own]);
    expect(h.ui.messages).toEqual([]);
  });

  it('runs the ffmpeg on PATH when followalong.ffmpegPath is not a full path, and says so once', async () => {
    const h = await createHarness();
    h.config.set('ffmpegPath', 'tools/ffmpeg');
    await openMp4Lesson(h, false, 'first');
    await openMp4Lesson(h, false, 'second');
    h.config.set('ffmpegPath', '   ');
    await openMp4Lesson(h, false, 'third');

    expect(h.converter.requests.map(({ request }) => request.program)).toEqual([
      'ffmpeg',
      'ffmpeg',
      'ffmpeg',
    ]);
    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: 'FollowAlong ignores the followalong.ffmpegPath setting “tools/ffmpeg”: it must be a full path, such as C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe. It uses ffmpeg on PATH instead.',
      },
    ]);
  });

  it('writes the prepared sound where the player reads it', async () => {
    const h = await createHarness();
    const course = await openMp4Lesson(h, false);
    await h.converter.requests[0]?.succeed();
    await h.settle();

    const [file] = await h.listFiles(join(course, '.followalong', 'sound'));
    expect(file).toMatch(/^01 Intro-[0-9a-f]{16}\.mp3$/);
    expect(h.player.shown.at(-1)?.resourceRoots.some((root) => course.startsWith(root))).toBe(true);
  });

  it('says once why the sound could not be prepared, and lets the player play the Lesson without it', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, false);
    h.converter.requests[0]?.fail('spawn ffmpeg ENOENT');
    await h.settle();

    expect(h.ui.messages).toEqual([
      {
        severity: 'error',
        text: 'FollowAlong could not prepare the sound of “Intro”: spawn ffmpeg ENOENT',
      },
    ]);
    expect(h.player.sent.filter((command) => command.type === 'soundFailed')).toEqual([
      { type: 'soundFailed', message: 'spawn ffmpeg ENOENT' },
    ]);
    expect(soundCommands(h)).toEqual([]);
  });

  it('stops preparing the sound of a Lesson the learner left, and sends none for it', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '01 Intro.mp4': 'first mp4',
      '02 Setup.mp4': 'second mp4',
    });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();
    const left = h.converter.requests[0];

    h.core.nextLesson();
    await h.settle();

    expect(left?.request.signal.aborted).toBe(true);
    expect(h.converter.requests).toHaveLength(2);
    expect(h.converter.requests[1]?.request.input).toBe(join(course, '02 Setup.mp4'));
    left?.fail('The operation was aborted');
    await h.converter.requests[1]?.succeed();
    await h.settle();

    expect(soundCommands(h)).toEqual([
      {
        type: 'soundReady',
        audioUri: h.player.resourceUri(h.converter.requests[1]?.request.output ?? ''),
      },
    ]);
    expect(h.ui.messages).toEqual([]);
  });

  it('keeps preparing the sound when the player page reloads, and sends it to the new page', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, false);

    h.player.ready(false);
    await h.settle();
    expect(h.converter.requests).toHaveLength(1);
    expect(h.converter.requests[0]?.request.signal.aborted).toBe(false);
    await h.converter.requests[0]?.succeed();
    await h.settle();

    const loads = h.player.sent.filter((command) => command.type === 'load');
    expect(loads).toHaveLength(2);
    expect(h.player.sent.at(-1)).toEqual({
      type: 'soundReady',
      audioUri: h.player.resourceUri(h.converter.requests[0]?.request.output ?? ''),
    });
    expect(soundCommands(h)).toHaveLength(1);
  });

  it('loads the Lesson to play by itself, and sends its sound after the load', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, false);
    await h.converter.requests[0]?.succeed();
    await h.settle();

    const sent = h.player.sent.filter(
      (command) => command.type === 'load' || command.type === 'soundReady',
    );
    expect(sent.map((command) => command.type)).toEqual(['load', 'soundReady']);
    expect(sent[0]).toMatchObject({ type: 'load', autoplay: true, container: 'mp4' });
  });

  it('tells a reloaded player page the sound failed, without saying it to the learner again', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, false);
    h.converter.requests[0]?.fail('ffmpeg exited with code 1');
    await h.settle();

    h.player.ready(false);
    await h.settle();

    expect(h.ui.messages).toHaveLength(1);
    expect(h.player.sent.filter((command) => command.type === 'soundFailed')).toHaveLength(2);
    expect(h.player.sent.at(-1)).toEqual({
      type: 'soundFailed',
      message: 'ffmpeg exited with code 1',
    });
    expect(h.converter.requests).toHaveLength(1);
  });

  it('stops preparing the sound when the learner opens a Course with no Lessons', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, false);
    const empty = await h.folder('empty', { 'notes.txt': 'no videos here' });

    await h.core.openCourse(empty);

    expect(h.converter.requests[0]?.request.signal.aborted).toBe(true);
  });

  it('stops preparing the sound when the learner closes the player', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, false);

    h.player.close();

    expect(h.converter.requests[0]?.request.signal.aborted).toBe(true);
  });

  it('keeps preparing the sound when the learner picks the Lesson again while it is prepared', async () => {
    const h = await createHarness();
    await openMp4Lesson(h, false);

    h.core.playLesson(lessonId);
    await h.settle();

    expect(h.converter.requests).toHaveLength(1);
    expect(h.converter.requests[0]?.request.signal.aborted).toBe(false);
    await h.converter.requests[0]?.succeed();
    await h.settle();
    expect(h.player.sent.at(-1)).toEqual({
      type: 'soundReady',
      audioUri: h.player.resourceUri(h.converter.requests[0]?.request.output ?? ''),
    });
  });

  it('stops preparing the sound when the learner moves on to a WebM Lesson', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '01 Intro.mp4': 'first mp4',
      '02 Setup.webm': 'second webm',
    });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();

    h.core.nextLesson();

    expect(h.converter.requests[0]?.request.signal.aborted).toBe(true);
  });

  it('sends nothing for the sound of a Lesson the learner left, even when it is prepared after all', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '01 Intro.mp4': 'first mp4',
      '02 Setup.mp4': 'second mp4',
    });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();
    const left = h.converter.requests[0];

    h.core.nextLesson();
    await h.settle();
    // ffmpeg had finished just as the learner moved on: the old conversion succeeds anyway.
    await left?.succeed();
    await h.settle();

    expect(soundCommands(h)).toEqual([]);
    await h.converter.requests[1]?.succeed();
    await h.settle();
    expect(soundCommands(h)).toEqual([
      {
        type: 'soundReady',
        audioUri: h.player.resourceUri(h.converter.requests[1]?.request.output ?? ''),
      },
    ]);
  });
});
