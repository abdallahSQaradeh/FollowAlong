/**
 * Seam 2: an MP4 Lesson whose AAC sound the player cannot decode plays muted, beside its sound
 * converted to MP3 (the audio sidecar, ADR 0034). The video is the clock; the sound follows its
 * play, pause, seeks and rate, within about 0.1 s. Stock Chromium decodes AAC, so the harness
 * forces the "AAC unsupported" answer VS Code gives.
 */
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
    videoUri: media.longMp4,
    container: 'mp4',
    startAt: 0,
    autoplay: true,
    ...overrides,
  };
}

const soundReady: PlayerCommand = { type: 'soundReady', audioUri: media.longMp3 };

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
  test('waits for the sound, then plays the muted video with it, in step', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.post(loadMp4());
    await aMoment();

    expect((await player.events()).map((event) => event.type)).not.toContain('played');
    expect((await player.video()).paused).toBe(true);

    await player.post(soundReady);
    await player.waitForEvent({ type: 'played', lessonId });

    const video = await player.video();
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(false);
    expect((await player.sound()).source).toBe(media.longMp3);
    expect((await player.sound()).muted).toBe(false);
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

  test('plays the muted video when the sound could not be prepared', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.post(loadMp4());
    await aMoment();
    await player.post({ type: 'soundFailed', message: 'spawn ffmpeg ENOENT' });
    await player.waitForEvent({ type: 'played', lessonId });

    const video = await player.video();
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(false);
    expect((await player.sound()).source).toBe('');
  });

  test('stays paused, sound and all, until a click when VS Code refuses to play sound', async ({
    page,
  }) => {
    // Without a user gesture Chromium lets a muted video play, but not the sound (#12 D3).
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
