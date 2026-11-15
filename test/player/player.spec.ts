import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, webmDuration } from './player-page.js';

const lessonId = 'Section 1/01 Welcome.webm';

/** A `load` of the WebM fixture that autoplays from the start, unless overridden. */
function load(overrides: Partial<Extract<PlayerCommand, { type: 'load' }>> = {}): PlayerCommand {
  return {
    type: 'load',
    lessonId,
    videoUri: media.webm,
    container: 'webm',
    startAt: 0,
    autoplay: true,
    ...overrides,
  };
}

test.describe('the player', () => {
  test('reports ready, saying AAC plays where it does', async ({ page }) => {
    const player = await openPlayer(page, { aac: true });

    expect(await player.events()).toEqual([{ type: 'ready', aacSupported: true }]);
  });

  test('reports ready, saying AAC does not play in VS Code', async ({ page }) => {
    const player = await openPlayer(page, { aac: false });

    expect(await player.events()).toEqual([{ type: 'ready', aacSupported: false }]);
  });

  test('plays a WebM Lesson through MediaSource, with sound', async ({ page }) => {
    const player = await openPlayer(page);

    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(0.5);

    const video = await player.video();
    expect(video.currentSrc).toMatch(/^blob:/);
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(1);
    expect(video.audioBytesDecoded).toBeGreaterThan(0);
    expect(video.videoBytesDecoded).toBeGreaterThan(0);
    const updates = (await player.events()).filter((event) => event.type === 'timeUpdate');
    const last = updates.at(-1);
    expect(last).toMatchObject({ lessonId });
    expect(last?.position).toBeGreaterThan(0);
    expect(last?.duration).toBeCloseTo(webmDuration, 1);
  });

  test('pauses and plays on command', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });

    await player.post({ type: 'pause' });
    await player.waitForEvent({ type: 'paused', lessonId, byUser: false });
    expect((await player.video()).paused).toBe(true);

    await player.post({ type: 'play' });
    await expect.poll(async () => (await player.video()).paused).toBe(false);
    const events = (await player.events()).filter((event) => event.type === 'played');
    expect(events).toHaveLength(2);
  });

  test('reports a pause the learner made as theirs', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });

    // The native control bar pauses the element directly, as this does.
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.pause();
    });

    await player.waitForEvent({ type: 'paused', lessonId, byUser: true });
  });

  test('loads paused at the start position when autoplay is off', async ({ page }) => {
    const player = await openPlayer(page);

    await player.post(load({ startAt: 1.5, autoplay: false }));

    await expect.poll(async () => (await player.video()).currentTime).toBeCloseTo(1.5, 1);
    expect((await player.video()).paused).toBe(true);
    expect((await player.events()).map((event) => event.type)).not.toContain('played');
  });

  test('reports the end of the Lesson', async ({ page }) => {
    const player = await openPlayer(page);

    await player.post(load({ startAt: webmDuration - 0.5 }));

    await player.waitForEvent({ type: 'ended', lessonId });
    expect((await player.video()).ended).toBe(true);
    expect(await player.events()).toContainEqual({ type: 'paused', lessonId, byUser: false });
  });

  test('reports a learner pause as theirs after a pause command and a new load', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });

    // Both arrive before the media element fires `pause`; the load cancels that event.
    await player.postAll([{ type: 'pause' }, load({ lessonId: 'next.webm' })]);
    await player.waitForEvent({ type: 'played', lessonId: 'next.webm' });
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.pause();
    });

    await player.waitForEvent({ type: 'paused', lessonId: 'next.webm', byUser: true });
  });

  for (const [what, videoUri] of [
    ['not a playable WebM', media.notAVideo],
    ['an empty download', media.empty],
  ] as const) {
    test(`reports one error, and nothing after it, when the Lesson is ${what}`, async ({
      page,
    }) => {
      const player = await openPlayer(page);

      await player.post(load({ videoUri }));
      await player.waitForEvent({ type: 'error', lessonId });
      await page.waitForTimeout(500);

      const events = (await player.events()).filter((event) => event.type !== 'ready');
      expect(events.map((event) => event.type)).toEqual(['error']);
      expect((await player.video()).paused).toBe(true);
    });
  }

  test('ignores messages that are not protocol commands', async ({ page }) => {
    const player = await openPlayer(page);

    await page.evaluate(() => {
      window.postMessage({ type: 'load', videoUri: 42 }, '*');
      window.postMessage('play', '*');
    });

    expect((await player.video()).currentSrc).toBe('');
    expect(await player.events()).toEqual([{ type: 'ready', aacSupported: expect.any(Boolean) }]);
  });
});
