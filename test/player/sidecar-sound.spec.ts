/**
 * Seam 2: an MP4 Lesson whose AAC sound the player cannot decode plays beside its sound converted
 * to MP3 (the audio sidecar, ADR 0034). The video is the clock; the sound follows its play, pause,
 * seeks and rate, within about 0.1 s, and its volume and mute. Stock Chromium decodes AAC, so the
 * harness forces the "AAC unsupported" answer VS Code gives.
 */
import type { Page } from '@playwright/test';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, spots, type PlayerHarness } from './player-page.js';

const lessonId = 'Section 1/03 Closures.mp4';
/** How far the sound may be from the picture (spec #12: drift correction above about 0.1 s). */
const inStep = 0.1;

function loadMp4(overrides: Partial<Extract<PlayerCommand, { type: 'load' }>> = {}): PlayerCommand {
  return {
    type: 'load',
    lessonId,
    videoUri: media.sidecarMp4,
    container: 'mp4',
    startAt: 0,
    autoplay: true,
    ...overrides,
  };
}

const soundReady: PlayerCommand = { type: 'soundReady', audioUri: media.sidecarMp3 };

/** Waits a moment in which the player could act, to check that it did not. */
async function aMoment(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * Checks, over about half a second of playback, that the sound plays and stays within 0.1 s of
 * the picture.
 */
async function expectSoundInStep(player: PlayerHarness): Promise<void> {
  // Let a seek or a rate change settle first: the sound follows within a few frames.
  await expect
    .poll(async () => {
      const { video, sound } = await player.playheads();
      return Math.abs(video - sound);
    })
    .toBeLessThanOrEqual(inStep);
  const first = await player.playheads();
  for (let sample = 0; sample < 5; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { video, sound } = await player.playheads();
    expect(
      Math.abs(video - sound),
      `sample ${String(sample)}: video ${String(video)}, sound ${String(sound)}`,
    ).toBeLessThanOrEqual(inStep);
  }
  const last = await player.playheads();
  expect(last.video).toBeGreaterThan(first.video);
  expect((await player.sound()).paused).toBe(false);
}

test.describe('sound for an MP4 Lesson when AAC does not play', () => {
  test('waits for the sound, then plays the video with it, in step', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.post(loadMp4());
    await aMoment();

    expect((await player.events()).map((event) => event.type)).not.toContain('played');
    expect((await player.video()).paused).toBe(true);

    await player.post(soundReady);
    await player.waitForEvent({ type: 'played', lessonId });

    expect((await player.video()).paused).toBe(false);
    const sound = await player.sound();
    expect(sound.source).toBe(media.sidecarMp3);
    expect(sound.muted).toBe(false);
    expect(sound.volume).toBe(1);
    await expectSoundInStep(player);
  });

  test('keeps the sound in step after seeks forward and back', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), soundReady]);
    await player.waitForEvent({ type: 'played', lessonId });

    await player.post({ type: 'seekBy', seconds: 4 });
    await player.waitForEvent({ type: 'seeked', lessonId });
    await expectSoundInStep(player);
    expect((await player.playheads()).sound).toBeGreaterThan(4);

    const seeks = (await player.events()).filter((event) => event.type === 'seeked').length;
    await player.post({ type: 'seekBy', seconds: -3 });
    await expect
      .poll(async () => (await player.events()).filter((event) => event.type === 'seeked').length)
      .toBe(seeks + 1);
    await expectSoundInStep(player);
  });

  test('keeps the sound in step at every rate of the speed ladder', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), soundReady]);
    await player.waitForEvent({ type: 'played', lessonId });

    for (const rate of [2, 0.75, 1.5]) {
      await player.post({ type: 'setRate', rate });
      await player.waitForEvent({ type: 'rateChanged', lessonId, rate });
      expect((await player.sound()).playbackRate).toBe(rate);
      await expectSoundInStep(player);
    }
  });

  test('pauses the sound with the video, and plays both again in step', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), soundReady]);
    await player.waitForEvent({ type: 'played', lessonId });

    await player.post({ type: 'pause' });
    await player.waitForEvent({ type: 'paused', lessonId });
    expect((await player.sound()).paused).toBe(true);

    await player.post({ type: 'play' });
    await expect.poll(async () => (await player.video()).paused).toBe(false);
    await expectSoundInStep(player);
  });

  test('waits for the learner to press play when the Lesson was loaded paused', async ({
    page,
  }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4({ autoplay: false, startAt: 2 }), soundReady]);
    await aMoment();

    expect((await player.events()).map((event) => event.type)).not.toContain('played');
    expect((await player.sound()).paused).toBe(true);

    await player.post({ type: 'play' });
    await player.waitForEvent({ type: 'played', lessonId });
    await expectSoundInStep(player);
    expect((await player.playheads()).sound).toBeGreaterThan(2);
  });

  test('starts once the sound is ready when the learner pressed play before', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.post(loadMp4({ autoplay: false }));
    const { picture } = await spots(page);
    await page.mouse.click(picture.x, picture.y);
    await aMoment();

    expect((await player.events()).map((event) => event.type)).not.toContain('played');
    expect((await player.video()).paused).toBe(true);

    await player.post(soundReady);
    await player.waitForEvent({ type: 'played', lessonId });
    await expectSoundInStep(player);
  });

  test('stays paused, sound and all, until a click when VS Code refuses to play sound', async ({
    page,
  }) => {
    // Without a user gesture Chromium refuses to play sound (#12 D3), as VS Code does.
    const player = await openPlayer(page, { aac: false, userGestures: false });
    await player.postAll([loadMp4(), soundReady]);
    await player.waitForEvent({ type: 'paused', lessonId, byUser: false });
    await aMoment();

    expect((await player.events()).map((event) => event.type)).not.toContain('played');
    expect((await player.video()).paused).toBe(true);
    expect((await player.sound()).paused).toBe(true);

    const { picture } = await spots(page);
    await page.mouse.click(picture.x, picture.y);
    await player.waitForEvent({ type: 'played', lessonId });
    await expectSoundInStep(player);
  });

  test('drops the sound of the Lesson before when another Lesson loads', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), soundReady]);
    await player.waitForEvent({ type: 'played', lessonId });
    const webmId = 'Section 1/04 Scope.webm';

    await player.post({
      type: 'load',
      lessonId: webmId,
      videoUri: media.webm,
      container: 'webm',
      startAt: 0,
      autoplay: true,
    });
    await player.waitForEvent({ type: 'played', lessonId: webmId });

    const sound = await player.sound();
    expect(sound.paused).toBe(true);
    expect(sound.source).toBe('');
    expect((await player.video()).muted).toBe(false);
  });
});

test.describe('an MP4 Lesson when AAC plays', () => {
  test('plays with its own sound, with no sidecar', async ({ page }) => {
    const player = await openPlayer(page, { aac: true });
    await player.post(loadMp4());
    await player.waitForEvent({ type: 'played', lessonId });

    const video = await player.video();
    expect(video.muted).toBe(false);
    expect(video.audioBytesDecoded).toBeGreaterThan(0);
    expect((await player.sound()).source).toBe('');
  });

  test('seeks in an MP4 whose index is at the end of the file', async ({ page }) => {
    const player = await openPlayer(page, { aac: true });
    await player.post(loadMp4({ autoplay: false }));
    await expect.poll(async () => (await player.video()).duration).toBeCloseTo(8, 0);

    await player.post({ type: 'seekBy', seconds: 6 });
    await player.waitForEvent({ type: 'seeked', lessonId });
    expect((await player.video()).currentTime).toBeCloseTo(6, 1);

    await player.post({ type: 'play' });
    await player.waitForEvent({ type: 'played', lessonId });
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(6.3);
    // The index at the end was reached with a Range request, as VS Code serves local files.
    expect(player.rangeRequests().length).toBeGreaterThan(0);
  });
});

test('loading an MP4 Lesson that waits for its sound is not an interaction of the learner', async ({
  page,
}) => {
  const player = await openPlayer(page, { aac: false });
  await player.postAll([loadMp4(), soundReady]);
  await player.waitForEvent({ type: 'played', lessonId });
  await player.post({
    type: 'load',
    lessonId: 'Section 1/04 Scope.webm',
    videoUri: media.webm,
    container: 'webm',
    startAt: 0,
    autoplay: false,
  });
  await aMoment();

  expect((await player.events()).map((event) => event.type)).not.toContain('userInteracted');
});

/**
 * What the native mute button does: it flips the video's `muted`. Pressed through the page, as a
 * click on the control bar would, without depending on when Chromium shows the bar.
 */
async function pressMute(player: PlayerHarness, page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video !== null) {
      video.muted = !video.muted;
    }
  });
  // The page answers in its `volumechange` listener, a task later.
  await player.video();
}

test('the sidecar follows the volume slider and the mute button, both ways', async ({ page }) => {
  const player = await openPlayer(page, { aac: false });
  await player.postAll([loadMp4(), soundReady]);
  await player.waitForEvent({ type: 'played', lessonId });

  await pressMute(player, page);
  await expect.poll(async () => (await player.sound()).muted).toBe(true);
  await pressMute(player, page);
  await expect.poll(async () => (await player.sound()).muted).toBe(false);

  for (const volume of [0.4, 1]) {
    await page.evaluate((level) => {
      const video = document.querySelector('video');
      if (video !== null) {
        video.volume = level;
      }
    }, volume);
    await expect.poll(async () => (await player.sound()).volume).toBeCloseTo(volume);
  }
  await expectSoundInStep(player);
});

test("gives the next MP4 Lesson's sidecar the mute the learner chose before", async ({ page }) => {
  const player = await openPlayer(page, { aac: false });
  await player.post({
    type: 'load',
    lessonId: 'Section 1/04 Scope.webm',
    videoUri: media.webm,
    container: 'webm',
    startAt: 0,
    autoplay: false,
  });
  await pressMute(player, page);
  await expect.poll(async () => (await player.video()).muted).toBe(true);

  await player.postAll([loadMp4(), soundReady]);
  await player.waitForEvent({ type: 'played', lessonId });

  expect((await player.video()).muted).toBe(true);
  expect((await player.sound()).muted).toBe(true);
});

test('the sidecar plays only while the video plays, also from its native play button', async ({
  page,
}) => {
  const player = await openPlayer(page, { aac: false });
  await player.postAll([loadMp4({ autoplay: false }), soundReady]);
  await aMoment();
  expect((await player.sound()).paused).toBe(true);

  // What the native play and pause buttons do.
  await page.evaluate(() => document.querySelector('video')?.play());
  await player.waitForEvent({ type: 'played', lessonId });
  await expectSoundInStep(player);

  await page.evaluate(() => {
    document.querySelector('video')?.pause();
  });
  await player.waitForEvent({ type: 'paused', lessonId });
  await aMoment();
  expect((await player.sound()).paused).toBe(true);
});

test('hides the native control bar while the sound is awaited, also after a zoom reset', async ({
  page,
}) => {
  const player = await openPlayer(page, { aac: false });
  await player.post(loadMp4({ autoplay: false }));
  await aMoment();
  expect((await player.video()).controls).toBe(false);

  await player.post({ type: 'zoom', action: 'reset' });
  await aMoment();
  expect((await player.video()).controls).toBe(false);

  await player.post(soundReady);
  await expect.poll(async () => (await player.video()).controls).toBe(true);
});

test('never plays the sound of a Lesson whose video failed', async ({ page }) => {
  const player = await openPlayer(page, { aac: false });
  // The sidecar must never be given a source, nor asked to play, whatever the extension sends.
  await page.evaluate(() => {
    const sidecar = document.querySelector('audio');
    const sources: string[] = [];
    let plays = 0;
    new MutationObserver(() => {
      sources.push(sidecar?.getAttribute('src') ?? '');
    }).observe(sidecar ?? document, { attributes: true, attributeFilter: ['src'] });
    sidecar?.addEventListener('play', () => {
      plays += 1;
    });
    Object.assign(window, { followalongSidecarSources: sources });
    Object.defineProperty(window, 'followalongSidecarPlays', { get: () => plays });
  });
  // An MP4 the page cannot play (another codec, a broken file), while its sound was prepared.
  await player.post(loadMp4({ videoUri: media.notAVideo }));
  await player.waitForEvent({ type: 'error', lessonId });

  await player.postAll([soundReady, { type: 'play' }]);
  await aMoment();
  await player.post({ type: 'play' });
  await aMoment();

  expect((await player.sound()).paused).toBe(true);
  expect((await player.events()).map((event) => event.type)).not.toContain('played');
  const touched = await page.evaluate(() => ({
    sources: (window as unknown as { followalongSidecarSources: string[] })
      .followalongSidecarSources,
    plays: (window as unknown as { followalongSidecarPlays: number }).followalongSidecarPlays,
  }));
  expect(touched.sources.filter((source) => source !== '')).toEqual([]);
  expect(touched.plays).toBe(0);
  expect((await player.sound()).source).toBe('');
});

test('moves the sound back to the picture when it drifts more than 0.1 s away', async ({
  page,
}) => {
  const player = await openPlayer(page, { aac: false });
  await player.postAll([loadMp4(), soundReady]);
  await player.waitForEvent({ type: 'played', lessonId });
  await expectSoundInStep(player);

  // The sound jumps a second ahead of the picture, as a stalled or late decoder would leave it.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    const video = document.querySelector('video');
    if (audio !== null && video !== null) {
      audio.currentTime = video.currentTime + 1;
    }
  });

  await expectSoundInStep(player);
});

test('plays the video as it is, with its controls, when it needs no sidecar', async ({ page }) => {
  // A silent MP4, or one whose sound the page decodes itself (MP3, Opus): no sidecar is coming.
  const player = await openPlayer(page, { aac: false });
  await player.post(loadMp4());
  await aMoment();
  expect((await player.video()).controls).toBe(false);

  await player.post({ type: 'noSidecar' });
  await player.waitForEvent({ type: 'played', lessonId });

  const video = await player.video();
  expect(video.controls).toBe(true);
  expect(video.muted).toBe(false);
  expect((await player.sound()).source).toBe('');
  expect((await player.sound()).paused).toBe(true);
});
