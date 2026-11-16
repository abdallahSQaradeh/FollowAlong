/**
 * Seam 2: what the learner sees over the first frame while an MP4 Lesson's sound is prepared, and
 * when preparing it fails (spec #12, stories 69, 70 and 72; ticket #42; ADR 0055). Stock Chromium
 * decodes AAC, so the harness forces the "AAC unsupported" answer VS Code gives.
 */
import type { Page } from '@playwright/test';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, spots } from './player-page.js';

const lessonId = 'Section 1/03 Closures.mp4';

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

/** Waits a moment in which the player could act, to check that it did not. */
async function aMoment(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

test.describe('"Preparing sound… N%"', () => {
  test('shows the first frame under the progress, which follows soundProgress', async ({
    page,
  }) => {
    const player = await openPlayer(page, { aac: false });
    await player.post(loadMp4());
    await player.post({ type: 'soundProgress', percent: 0 });

    await expect(page.getByText('Preparing sound… 0%')).toBeVisible();
    // The first frame is there, behind the words, and the Lesson has not started.
    await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => document.querySelector('video')?.readyState ?? 0))
      .toBeGreaterThanOrEqual(2);
    expect((await player.video()).paused).toBe(true);

    await player.post({ type: 'soundProgress', percent: 45 });
    await expect(page.getByText('Preparing sound… 45%')).toBeVisible();
    await expect(page.getByText('Preparing sound… 0%')).toBeHidden();
    await aMoment();
    expect((await player.events()).map((event) => event.type)).not.toContain('played');
    expect((await player.video()).controls).toBe(false);
  });

  test('goes when the sound is ready, and the Lesson then plays by itself', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), { type: 'soundProgress', percent: 90 }]);
    await expect(page.getByText('Preparing sound… 90%')).toBeVisible();

    await player.post({ type: 'soundReady', audioUri: media.sidecarMp3 });

    await player.waitForEvent({ type: 'played', lessonId });
    await expect(page.getByText(/Preparing sound/)).toBeHidden();
    expect((await player.video()).controls).toBe(true);
  });

  test('goes when the Lesson needs no sidecar', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), { type: 'soundProgress', percent: 10 }]);
    await expect(page.getByText('Preparing sound… 10%')).toBeVisible();

    await player.post({ type: 'noSidecar' });

    await expect(page.getByText(/Preparing sound/)).toBeHidden();
    await player.waitForEvent({ type: 'played', lessonId });
  });

  test('goes when another Lesson loads', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4({ autoplay: false }), { type: 'soundProgress', percent: 70 }]);
    await expect(page.getByText('Preparing sound… 70%')).toBeVisible();

    await player.post({
      type: 'load',
      lessonId: 'Section 1/04 Scope.webm',
      videoUri: media.webm,
      container: 'webm',
      startAt: 0,
      autoplay: false,
    });

    await expect(page.getByText(/Preparing sound/)).toBeHidden();
  });

  test('is not shown for a Lesson that plays with its own sound', async ({ page }) => {
    const player = await openPlayer(page, { aac: true });
    await player.postAll([loadMp4(), { type: 'soundProgress', percent: 30 }]);
    await player.waitForEvent({ type: 'played', lessonId });

    await expect(page.getByText(/Preparing sound/)).toBeHidden();
  });

  test('still lets the learner click the picture to play when the sound arrives', async ({
    page,
  }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4({ autoplay: false }), { type: 'soundProgress', percent: 20 }]);
    await expect(page.getByText('Preparing sound… 20%')).toBeVisible();

    const { picture } = await spots(page);
    await page.mouse.click(picture.x, picture.y);
    await aMoment();
    expect((await player.video()).paused).toBe(true);

    await player.post({ type: 'soundReady', audioUri: media.sidecarMp3 });
    await player.waitForEvent({ type: 'played', lessonId });
  });
});

test.describe('Play without sound', () => {
  const failure = 'ffmpeg exited with code 1: Invalid data found when processing input';

  test('shows one error and the button over the first frame, and holds the Lesson', async ({
    page,
  }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([
      loadMp4(),
      { type: 'soundProgress', percent: 30 },
      { type: 'soundFailed', message: failure },
    ]);

    await expect(page.getByText(failure)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play without sound' })).toBeVisible();
    await expect(page.getByText(/Preparing sound/)).toBeHidden();
    await expect(page.getByText(/could not prepare the sound/i)).toHaveCount(1);
    await aMoment();
    expect((await player.events()).map((event) => event.type)).not.toContain('played');
    const video = await player.video();
    expect(video.paused).toBe(true);
    expect(video.controls).toBe(false);
    expect((await player.sound()).source).toBe('');
  });

  test('does not play on a play command, a click on the picture or an autoplay: the button is the way', async ({
    page,
  }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), { type: 'soundFailed', message: failure }]);
    await expect(page.getByText(failure)).toBeVisible();

    await player.post({ type: 'play' });
    await aMoment();
    expect((await player.video()).paused).toBe(true);
    expect((await player.events()).map((event) => event.type)).not.toContain('played');
  });

  test('plays the picture alone and tells the extension when the learner clicks the button', async ({
    page,
  }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), { type: 'soundFailed', message: failure }]);

    await page.getByRole('button', { name: 'Play without sound' }).click();

    await player.waitForEvent({ type: 'playWithoutSound', lessonId });
    await player.waitForEvent({ type: 'played', lessonId });
    expect((await player.video()).paused).toBe(false);
    expect((await player.video()).controls).toBe(true);
    const sound = await player.sound();
    expect(sound.source).toBe('');
    expect(sound.paused).toBe(true);
    await expect(page.getByText(failure)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Play without sound' })).toBeHidden();
    // The click is an interaction like any other: focus goes back to the code.
    await player.waitForEvent({ type: 'userInteracted' });
  });

  test('plays a Lesson loaded paused from where it was, once the learner chooses', async ({
    page,
  }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([
      loadMp4({ autoplay: false, startAt: 2 }),
      { type: 'soundFailed', message: failure },
    ]);
    await expect(page.getByText(failure)).toBeVisible();
    await aMoment();
    expect((await player.video()).paused).toBe(true);

    await page.getByRole('button', { name: 'Play without sound' }).click();

    await player.waitForEvent({ type: 'played', lessonId });
    expect((await player.video()).currentTime).toBeGreaterThanOrEqual(2);
  });

  test('goes when another Lesson loads, which plays as usual', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.postAll([loadMp4(), { type: 'soundFailed', message: failure }]);
    await expect(page.getByText(failure)).toBeVisible();

    await player.post({
      type: 'load',
      lessonId: 'Section 1/04 Scope.webm',
      videoUri: media.webm,
      container: 'webm',
      startAt: 0,
      autoplay: true,
    });

    await player.waitForEvent({ type: 'played', lessonId: 'Section 1/04 Scope.webm' });
    await expect(page.getByText(failure)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Play without sound' })).toBeHidden();
  });

  test('is not shown when the video itself failed, which has its own error', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });
    await player.post(loadMp4({ videoUri: media.notAVideo }));
    await player.waitForEvent({ type: 'error', lessonId });

    await player.post({ type: 'soundFailed', message: failure });
    await aMoment();

    await expect(page.getByRole('button', { name: 'Play without sound' })).toBeHidden();
  });
});

test.describe('the sound codecs the page reports', () => {
  const ready = async (page: Page, soundCodecs: readonly string[]) => {
    const player = await openPlayer(page, { aac: false, soundCodecs });
    await expect
      .poll(async () => (await player.events()).find((event) => event.type === 'ready'))
      .toEqual({ type: 'ready', aacSupported: false, soundCodecs });
  };

  test('lists the ones the page decodes in an MP4, besides AAC', async ({ page }) => {
    await ready(page, ['mp3', 'flac']);
  });

  test('lists none when the page decodes none', async ({ page }) => {
    await ready(page, []);
  });

  test('lists all three when the page decodes them all', async ({ page }) => {
    await ready(page, ['mp3', 'opus', 'flac']);
  });
});
