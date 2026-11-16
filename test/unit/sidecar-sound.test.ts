/**
 * The audio sidecar service (spec #12, Sound for MP4 Lessons; ticket #41): VS Code cannot decode
 * AAC, so an MP4 Lesson's sound is converted to MP3 and played beside the muted video.
 */
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

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
});
