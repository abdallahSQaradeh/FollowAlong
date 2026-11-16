/**
 * Which ffmpeg converts the sound of MP4 Lessons (spec #12, Sound for MP4 Lessons; ticket #43,
 * user story 73): the one the Windows x64 .vsix ships, unless `followalong.ffmpegPath` names
 * another; on a machine with no bundled ffmpeg, the one on PATH. Seam 1: a fake converter and
 * config, the real temp-dir file system for the bundled file, observed through the programs the
 * converter is asked to run and the messages the learner sees.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { createHarness, type Harness } from './harness.js';

/** Opens a Course with one MP4 Lesson in a player page that cannot decode AAC. */
async function openMp4Lesson(h: Harness, name = 'course'): Promise<void> {
  const course = await h.folder(name, { '01 Intro.mp4': `mp4 video with AAC sound (${name})` });
  await h.core.openCourse(course);
  h.player.ready(false);
  await h.settle();
}

/** The programs the converter was asked to run: every probe, then every conversion. */
function programs(h: Harness): { probes: string[]; conversions: string[] } {
  return {
    probes: h.converter.probes.map((probe) => probe.program),
    conversions: h.converter.requests.map(({ request }) => request.program),
  };
}

function soundFailures(h: Harness): PlayerCommand[] {
  return h.player.sent.filter((command) => command.type === 'soundFailed');
}

describe('the ffmpeg that converts the sound', () => {
  it('is the bundled ffmpeg when followalong.ffmpegPath is not set', async () => {
    const h = await createHarness();
    const bundled = await h.shipBundledFfmpeg({ present: true });

    await openMp4Lesson(h);

    expect(programs(h)).toEqual({ probes: [bundled], conversions: [bundled] });
    expect(h.ui.messages).toEqual([]);
  });

  it('is the bundled ffmpeg when followalong.ffmpegPath is empty or blank', async () => {
    const h = await createHarness();
    const bundled = await h.shipBundledFfmpeg({ present: true });
    h.config.set('ffmpegPath', '   ');

    await openMp4Lesson(h);

    expect(programs(h).conversions).toEqual([bundled]);
  });

  it('is the one followalong.ffmpegPath names, even when an ffmpeg is bundled', async () => {
    const h = await createHarness();
    await h.shipBundledFfmpeg({ present: true });
    const own = join(h.root, 'Tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
    h.config.set('ffmpegPath', own);

    await openMp4Lesson(h);

    expect(programs(h)).toEqual({ probes: [own], conversions: [own] });
    expect(h.ui.messages).toEqual([]);
  });

  it('follows the setting as the learner changes it, from one Lesson to the next', async () => {
    const h = await createHarness();
    const bundled = await h.shipBundledFfmpeg({ present: true });
    const own = join(h.root, 'Tools', 'ffmpeg.exe');
    await openMp4Lesson(h, 'first');
    h.config.set('ffmpegPath', own);
    await openMp4Lesson(h, 'second');
    h.config.set('ffmpegPath', '');
    await openMp4Lesson(h, 'third');

    expect(programs(h).conversions).toEqual([bundled, own, bundled]);
  });

  it('is ffmpeg on PATH when nothing is bundled, as on Linux and macOS', async () => {
    const h = await createHarness();

    await openMp4Lesson(h);

    expect(programs(h)).toEqual({ probes: ['ffmpeg'], conversions: ['ffmpeg'] });
  });

  it('is the bundled ffmpeg, and the learner is told why, when followalong.ffmpegPath is not a full path', async () => {
    const h = await createHarness();
    const bundled = await h.shipBundledFfmpeg({ present: true });
    h.config.set('ffmpegPath', 'tools/ffmpeg');

    await openMp4Lesson(h, 'first');
    await openMp4Lesson(h, 'second');

    expect(programs(h).conversions).toEqual([bundled, bundled]);
    expect(h.ui.messages).toEqual([
      {
        severity: 'warning',
        text: 'FollowAlong ignores the followalong.ffmpegPath setting “tools/ffmpeg”: it must be a full path, such as C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe. It uses the ffmpeg that comes with FollowAlong instead.',
      },
    ]);
  });

  it('plays without sound, and says how to fix it, when the bundled ffmpeg is gone from disk', async () => {
    const h = await createHarness();
    const bundled = await h.shipBundledFfmpeg({ present: false });

    await openMp4Lesson(h);

    // No ffmpeg is started: the failure is the one "Play without sound" already shows (#42).
    expect(programs(h)).toEqual({ probes: [], conversions: [] });
    expect(soundFailures(h)).toEqual([
      {
        type: 'soundFailed',
        message: `The ffmpeg that comes with FollowAlong is missing (${bundled}). Reinstall FollowAlong, or set followalong.ffmpegPath to an ffmpeg you installed.`,
      },
    ]);
    expect(h.ui.messages).toEqual([]);
  });

  it('still runs the one followalong.ffmpegPath names when the bundled ffmpeg is gone', async () => {
    const h = await createHarness();
    await h.shipBundledFfmpeg({ present: false });
    const own = join(h.root, 'Tools', 'ffmpeg.exe');
    h.config.set('ffmpegPath', own);

    await openMp4Lesson(h);

    expect(programs(h).conversions).toEqual([own]);
    expect(soundFailures(h)).toEqual([]);
  });

  it('tries the bundled ffmpeg again at the next Lesson, so a restored file works without a restart', async () => {
    const h = await createHarness();
    const course = await h.folder('course', {
      '01 Intro.mp4': 'first mp4',
      '02 Setup.mp4': 'second mp4',
    });
    await h.shipBundledFfmpeg({ present: false });
    await h.core.openCourse(course);
    h.player.ready(false);
    await h.settle();
    expect(soundFailures(h)).toHaveLength(1);

    const bundled = await h.shipBundledFfmpeg({ present: true });
    h.core.nextLesson();
    await h.settle();

    expect(programs(h).conversions).toEqual([bundled]);
  });
});
