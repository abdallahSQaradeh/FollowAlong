/**
 * Seam 2: an MP4 Lesson's audio sidecar stops while the picture is starved of data, and plays on
 * in step when the picture moves again (ticket #140, ADR 0034). The faststart MP4 is read in
 * parts, as a slow drive or a busy resource loader serves it, and one read is held back or every
 * read past a point is slow.
 */
import type { Page } from '@playwright/test';

import type { PlayerCommand, PlayerEvent } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, mp4Bytes, openPlayer, readMp4InParts, spots } from './player-page.js';

const lessonId = 'Section 1/05 Hoisting.mp4';
/** How far the sound may be from the picture (spec #12: drift correction above about 0.1 s). */
const inStep = 0.1;
const partBytes = 16 * 1024;

const loadMp4: PlayerCommand = {
  type: 'load',
  lessonId,
  videoUri: media.mp4,
  container: 'mp4',
  startAt: 0,
  autoplay: true,
};
const soundReady: PlayerCommand = { type: 'soundReady', audioUri: media.sidecarMp3 };

/** What the page saw of the picture and the sound since {@link watchDrift}. */
interface DriftWatch {
  /** The furthest the sound was from the picture, in seconds. */
  maxDrift: number;
  /** The playheads at that moment. */
  worst: string;
  /** The furthest the sound jumped back, in seconds. */
  maxBackJump: number;
  /** How many times the picture waited for data. */
  waiting: number;
}

declare global {
  interface Window {
    followalongDrift?: DriftWatch;
  }
}

/**
 * Samples the picture's and the sound's playheads every 20 ms in the page, until the Lesson ends.
 * A seek the player has not seen yet (its `seeking` event is still queued) is left out: the sound
 * follows it as soon as it is seen.
 */
async function watchDrift(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    const audio = document.querySelector('audio');
    if (video === null || audio === null) {
      throw new Error('The player page has no <video> or no <audio> element.');
    }
    const watch: DriftWatch = { maxDrift: 0, worst: '', maxBackJump: 0, waiting: 0 };
    window.followalongDrift = watch;
    let seekSeen = false;
    video.addEventListener('seeking', () => {
      seekSeen = true;
    });
    video.addEventListener('seeked', () => {
      seekSeen = false;
    });
    video.addEventListener('waiting', () => {
      watch.waiting += 1;
    });
    let lastSound = audio.currentTime;
    setInterval(() => {
      if (video.ended || (video.seeking && !seekSeen)) {
        return;
      }
      const drift = Math.abs(video.currentTime - audio.currentTime);
      if (drift > watch.maxDrift) {
        watch.maxDrift = drift;
        watch.worst = `video ${String(video.currentTime)}, sound ${String(audio.currentTime)}`;
      }
      watch.maxBackJump = Math.max(watch.maxBackJump, lastSound - audio.currentTime);
      lastSound = audio.currentTime;
    }, 20);
  });
}

async function watched(page: Page): Promise<DriftWatch> {
  const watch = await page.evaluate(() => window.followalongDrift);
  if (watch === undefined) {
    throw new Error('watchDrift was not called');
  }
  return watch;
}

function expectInStep(watch: DriftWatch): void {
  expect(watch.maxDrift, `worst: ${watch.worst}`).toBeLessThanOrEqual(inStep);
  expect(watch.maxBackJump).toBeLessThanOrEqual(inStep);
}

/** The types of the events the player sent after the first `from`. */
function typesAfter(events: readonly PlayerEvent[], from: number): string[] {
  return events.slice(from).map((event) => event.type);
}

/** Waits until the picture is starved: it waits for data while it is not paused. */
async function waitForStall(page: Page): Promise<void> {
  await expect.poll(async () => (await watched(page)).waiting).toBeGreaterThan(0);
}

test('stops the sound while a held-back read starves the picture, then plays both on in step', async ({
  page,
}) => {
  const player = await openPlayer(page, { aac: false });
  const reads = await readMp4InParts(page, { partBytes, holdFrom: Math.floor(mp4Bytes / 2) });
  await player.postAll([loadMp4, soundReady]);
  await player.waitForEvent({ type: 'played', lessonId });
  await watchDrift(page);
  const sent = (await player.events()).length;

  await reads.held;
  await waitForStall(page);
  const frozen = (await player.video()).currentTime;
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const stalled = await player.video();
  expect(stalled.paused).toBe(false);
  expect(stalled.currentTime).toBe(frozen);
  expect((await player.sound()).paused).toBe(true);

  reads.release();
  // Checked before the Lesson ends, which posts its own `paused`.
  await expect
    .poll(async () => (await player.video()).currentTime, { intervals: [50] })
    .toBeGreaterThan(frozen + 0.5);

  expect((await player.sound()).paused).toBe(false);
  expectInStep(await watched(page));
  // Progress and auto-pause see nothing of the stall.
  expect(typesAfter(await player.events(), sent)).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^(paused|played|userInteracted)$/)]),
  );
});

test("a learner's pause during a stall stays a pause when the data arrives", async ({ page }) => {
  const player = await openPlayer(page, { aac: false });
  const reads = await readMp4InParts(page, { partBytes, holdFrom: Math.floor(mp4Bytes / 2) });
  await player.postAll([loadMp4, soundReady]);
  await player.waitForEvent({ type: 'played', lessonId });
  await watchDrift(page);

  await reads.held;
  await waitForStall(page);
  const { picture } = await spots(page);
  await page.mouse.click(picture.x, picture.y);
  await player.waitForEvent({ type: 'paused', lessonId, byUser: true });
  const sent = (await player.events()).length;
  const pausedAt = await player.playheads();

  reads.release();
  await expect
    .poll(async () => {
      const { buffered } = await player.video();
      return Math.max(0, ...buffered.map(([, end]) => end));
    })
    .toBeGreaterThan(pausedAt.video + 0.5);
  await new Promise((resolve) => setTimeout(resolve, 400));

  expect((await player.video()).paused).toBe(true);
  expect((await player.sound()).paused).toBe(true);
  expect(await player.playheads()).toEqual(pausedAt);
  expect(typesAfter(await player.events(), sent)).not.toContain('played');
});

test('keeps the sound with the picture after a seek into data that is slow to arrive', async ({
  page,
}) => {
  const player = await openPlayer(page, { aac: false });
  await readMp4InParts(page, { partBytes, slowFrom: Math.floor(mp4Bytes * 0.4), slowMs: 800 });
  await player.postAll([loadMp4, soundReady]);
  await player.waitForEvent({ type: 'played', lessonId });
  await watchDrift(page);
  const sent = (await player.events()).length;

  await player.post({ type: 'seekBy', seconds: 1.5 });
  await player.waitForEvent({ type: 'seeked', lessonId });
  const target = (await player.video()).currentTime;
  // Checked before the Lesson ends, which posts its own `paused`.
  await expect
    .poll(async () => (await player.video()).currentTime, { intervals: [50] })
    .toBeGreaterThan(target + 0.3);

  const watch = await watched(page);
  expect(watch.waiting).toBeGreaterThan(0);
  expectInStep(watch);
  expect(typesAfter(await player.events(), sent)).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^(paused|played|userInteracted)$/)]),
  );
});
