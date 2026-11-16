import type { Page } from '@playwright/test';

import type { PlayerTuning } from '../../src/player/tuning.js';
import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, mp4Duration, openPlayer, webmDuration, type PlayerHarness } from './player-page.js';

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

  test('plays an MP4 Lesson straight from its file', async ({ page }) => {
    const player = await openPlayer(page);
    const mp4Id = 'Section 1/02 Setup.mp4';

    await player.post(load({ lessonId: mp4Id, videoUri: media.mp4, container: 'mp4' }));
    await player.waitForEvent({ type: 'played', lessonId: mp4Id });
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(0.5);

    const video = await player.video();
    expect(video.currentSrc).toBe(media.mp4);
    expect(video.paused).toBe(false);
    expect(video.videoBytesDecoded).toBeGreaterThan(0);
    const last = (await player.events()).filter((event) => event.type === 'timeUpdate').at(-1);
    expect(last).toMatchObject({ lessonId: mp4Id });
    expect(last?.duration).toBeCloseTo(mp4Duration, 1);
  });

  test('starts an MP4 Lesson at the given second, paused when not told to autoplay', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    const mp4Id = 'sample.mp4';

    await player.post(
      load({
        lessonId: mp4Id,
        videoUri: media.mp4,
        container: 'mp4',
        startAt: 1.5,
        autoplay: false,
      }),
    );

    await expect.poll(async () => (await player.video()).currentTime).toBeCloseTo(1.5, 1);
    expect((await player.video()).paused).toBe(true);
  });

  test('moves from an MP4 Lesson to a WebM Lesson and back', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load({ lessonId: 'a.mp4', videoUri: media.mp4, container: 'mp4' }));
    await player.waitForEvent({ type: 'played', lessonId: 'a.mp4' });

    await player.post(load({ lessonId: 'b.webm' }));
    await player.waitForEvent({ type: 'played', lessonId: 'b.webm' });
    expect((await player.video()).currentSrc).toMatch(/^blob:/);

    await player.post(load({ lessonId: 'c.mp4', videoUri: media.mp4, container: 'mp4' }));
    await player.waitForEvent({ type: 'played', lessonId: 'c.mp4' });
    expect((await player.video()).currentSrc).toBe(media.mp4);
    expect((await player.events()).filter((event) => event.type === 'error')).toEqual([]);
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

  test('reports the Lesson’s length as soon as it is known, before it plays', async ({ page }) => {
    const player = await openPlayer(page);

    await player.post(load({ autoplay: false }));

    await expect
      .poll(async () =>
        (await player.events()).find((event) => event.type === 'timeUpdate' && event.duration > 0),
      )
      .toMatchObject({ type: 'timeUpdate', lessonId, position: 0 });
    const known = (await player.events()).find(
      (event) => event.type === 'timeUpdate' && event.duration > 0,
    );
    expect(known?.type === 'timeUpdate' ? known.duration : 0).toBeCloseTo(webmDuration, 1);
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

  test('re-streams and plays on after a seek back into media it evicted', async ({ page }) => {
    // A 3 s quota makes the 8 s fixture behave like a Lesson larger than Chromium's MSE quota.
    const player = await openPlayer(page, {
      tuning: { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 },
    });
    await player.post(load({ videoUri: media.long, startAt: 6, autoplay: false }));
    // The playhead sits at 0:06 with media to play; filling the buffer dropped the start.
    await expect
      .poll(async () => {
        const video = await player.video();
        return video.buffered.some(
          ([from, to]) => from <= video.currentTime && to > video.currentTime + 0.5,
        );
      })
      .toBe(true);
    expect((await player.video()).currentTime).toBeCloseTo(6, 1);
    expect((await player.video()).buffered.some(([from]) => from < 2)).toBe(false);

    // The learner drags the seek bar back to 0:01 and plays.
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1;
      void video.play();
    });

    await player.waitForEvent({ type: 'played', lessonId });
    await expect
      .poll(
        async () =>
          (await player.events()).some(
            (event) => event.type === 'timeUpdate' && event.position > 1.6 && event.position < 4,
          ),
        { message: 'the playhead moves on from 0:01', timeout: 10_000 },
      )
      .toBe(true);
    expect((await player.events()).map((event) => event.type)).not.toContain('error');
  });

  test('reaches a start position past a full buffer with nothing behind it to drop', async ({
    page,
  }) => {
    // The buffer fills with 0:00–0:03, all within keepBehindSeconds (30 s) of the 0:06 target.
    const player = await openPlayer(page, { tuning: { appendBytes: 4096, quotaSeconds: 3 } });

    await player.post(load({ videoUri: media.long, startAt: 6 }));

    await player.waitForEvent({ type: 'played', lessonId });
    await expect
      .poll(async () =>
        (await player.events()).some(
          (event) => event.type === 'timeUpdate' && event.position > 6.3,
        ),
      )
      .toBe(true);
  });

  test('re-streams again after a second seek back into media evicted after a re-stream', async ({
    page,
  }) => {
    const player = await openPlayer(page, {
      tuning: { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 },
    });
    await player.post(load({ videoUri: media.long, startAt: 6, autoplay: false }));
    await expect.poll(async () => (await player.video()).currentTime).toBeCloseTo(6, 1);
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1;
      void video.play();
    });
    // Played on far enough that 0:02 was dropped again.
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(4.2);
    expect((await player.video()).buffered.some(([from]) => from <= 2.2)).toBe(false);

    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.currentTime = 2.2;
      void video.play();
    });

    await expect
      .poll(
        async () =>
          (await player.events()).some(
            (event) => event.type === 'timeUpdate' && event.position > 2.6 && event.position < 3.9,
          ),
        { message: 'the playhead moves on from 0:02.2', timeout: 10_000 },
      )
      .toBe(true);
  });

  test('plays on after two quick seeks back', async ({ page }) => {
    const player = await openPlayer(page, {
      tuning: { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 },
    });
    await player.post(load({ videoUri: media.long, startAt: 6, autoplay: false }));
    await expect.poll(async () => (await player.video()).currentTime).toBeCloseTo(6, 1);

    // Two separate seeks, the second while the first one's re-stream is under way.
    await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
      video.currentTime = 3;
      await new Promise((resolve) => setTimeout(resolve, 30));
      video.currentTime = 1;
      void video.play();
    });

    await expect
      .poll(async () =>
        (await player.events()).some(
          (event) => event.type === 'timeUpdate' && event.position > 1.6 && event.position < 4,
        ),
      )
      .toBe(true);
    expect((await player.events()).map((event) => event.type)).not.toContain('error');
  });

  test('reports an error, instead of stalling, when re-streaming fails', async ({ page }) => {
    const player = await openPlayer(page, {
      tuning: { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 },
      brokenRanges: true,
    });
    await player.post(load({ videoUri: media.long, startAt: 6, autoplay: false }));
    await expect.poll(async () => (await player.video()).currentTime).toBeCloseTo(6, 1);

    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1;
      // The player pauses the failed Lesson, which interrupts this play().
      video.play().catch(() => undefined);
    });

    await player.waitForEvent({ type: 'error', lessonId });
  });

  test.describe('seekBy', () => {
    /** Loads the 8 s fixture paused and waits until all of it is buffered. */
    async function loadLong(page: Page, tuning?: PlayerTuning) {
      const player = await openPlayer(page, tuning === undefined ? {} : { tuning });
      await player.post(load({ videoUri: media.long, autoplay: false }));
      await expect
        .poll(async () => (await player.video()).buffered.at(-1)?.[1] ?? 0, {
          message: 'the whole Lesson is buffered',
        })
        .toBeGreaterThan(7.5);
      return player;
    }

    /** How many `seeked` events the player has sent. */
    async function seekedCount(player: PlayerHarness): Promise<number> {
      return (await player.events()).filter((event) => event.type === 'seeked').length;
    }

    test('moves the playhead by the given seconds and reports seeked', async ({ page }) => {
      const player = await loadLong(page);

      await player.post({ type: 'seekBy', seconds: 2 });
      await player.waitForEvent({ type: 'seeked', lessonId });
      expect((await player.video()).currentTime).toBeCloseTo(2, 1);

      await player.post({ type: 'seekBy', seconds: -1.5 });
      await expect.poll(() => seekedCount(player)).toBe(2);
      expect((await player.video()).currentTime).toBeCloseTo(0.5, 1);
    });

    test('stops at the start of the Lesson when stepping back past it', async ({ page }) => {
      const player = await loadLong(page);

      await player.post({ type: 'seekBy', seconds: -30 });

      await player.waitForEvent({ type: 'seeked', lessonId });
      expect((await player.video()).currentTime).toBe(0);
    });

    test('stops at the end of the Lesson when stepping forward past it', async ({ page }) => {
      const player = await loadLong(page);
      const { duration } = await player.video();

      await player.post({ type: 'seekBy', seconds: 30 });

      await player.waitForEvent({ type: 'seeked', lessonId });
      expect((await player.video()).currentTime).toBe(duration);
    });

    test('works for an MP4 Lesson', async ({ page }) => {
      const player = await openPlayer(page);
      const mp4Id = 'sample.mp4';
      await player.post(
        load({ lessonId: mp4Id, videoUri: media.mp4, container: 'mp4', autoplay: false }),
      );
      await player.waitForEvent({ type: 'timeUpdate', lessonId: mp4Id });

      await player.post({ type: 'seekBy', seconds: 1 });

      await player.waitForEvent({ type: 'seeked', lessonId: mp4Id });
      expect((await player.video()).currentTime).toBeCloseTo(1, 1);
    });

    test('steps back past media the buffer evicted, and plays on from there', async ({ page }) => {
      // A 3 s quota makes the 8 s fixture behave like a Lesson larger than Chromium's MSE quota.
      const player = await openPlayer(page, {
        tuning: { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 },
      });
      await player.post(load({ videoUri: media.long, startAt: 6, autoplay: false }));
      await expect
        .poll(
          async () => {
            const video = await player.video();
            return video.buffered.some(
              ([from, to]) => from <= video.currentTime && to > video.currentTime + 0.5,
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      expect((await player.video()).buffered.some(([from]) => from < 2)).toBe(false);

      await player.post({ type: 'seekBy', seconds: -5 });
      await player.post({ type: 'play' });

      await player.waitForEvent({ type: 'seeked', lessonId });
      await player.waitForEvent({ type: 'played', lessonId });
      await expect
        .poll(
          async () =>
            (await player.events()).some(
              (event) => event.type === 'timeUpdate' && event.position > 1.6 && event.position < 4,
            ),
          { message: 'the playhead moves on from 0:01', timeout: 10_000 },
        )
        .toBe(true);
      expect((await player.events()).map((event) => event.type)).not.toContain('error');
    });
  });

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
