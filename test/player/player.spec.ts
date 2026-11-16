import type { Page } from '@playwright/test';

import type { PlayerTuning } from '../../src/player/tuning.js';
import type { PlayerCommand, PlayerEvent } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import {
  longClusterOffset,
  media,
  mp4Duration,
  noDurationClusterOffset,
  openPlayer,
  webmDuration,
  type PlayerHarness,
} from './player-page.js';

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

/**
 * Whether the player posted `seeked` for `lessonId`, after a `timeUpdate` at `position` (the core
 * reads the new position from that `timeUpdate` when `seeked` arrives).
 */
function seekedAt(events: readonly PlayerEvent[], position: number): boolean {
  const seeked = events.findIndex(
    (event) => event.type === 'seeked' && event.lessonId === lessonId,
  );
  return events
    .slice(0, seeked === -1 ? 0 : seeked)
    .some(
      (event) =>
        event.type === 'timeUpdate' &&
        event.lessonId === lessonId &&
        Math.abs(event.position - position) < 0.1,
    );
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

  test('echoes the loadId of the load on every event about the Lesson', async ({ page }) => {
    const player = await openPlayer(page);

    await player.post(load({ loadId: 7 }));
    await player.waitForEvent({ type: 'played', lessonId });
    await player.post({ type: 'seekBy', seconds: 1 });
    await player.waitForEvent({ type: 'seeked', lessonId });
    await player.post({ type: 'pause' });
    await player.waitForEvent({ type: 'paused', lessonId });

    const aboutTheLesson = (await player.events()).filter((event) => 'lessonId' in event);
    expect(new Set(aboutTheLesson.map((event) => event.type))).toEqual(
      new Set(['timeUpdate', 'played', 'seeked', 'paused']),
    );
    for (const event of aboutTheLesson) {
      expect(event).toMatchObject({ lessonId, loadId: 7 });
    }
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

  for (const [container, videoUri, duration] of [
    ['webm', media.webm, webmDuration],
    ['mp4', media.mp4, mp4Duration],
  ] as const) {
    test(`reports a seek the learner made, after the time it moved to (${container})`, async ({
      page,
    }) => {
      const player = await openPlayer(page);
      await player.post(load({ videoUri, container, autoplay: false }));
      await expect.poll(async () => (await player.video()).duration).toBeCloseTo(duration, 1);

      // The native seek bar sets the playhead directly, as this does.
      await page.locator('video').evaluate((video: HTMLVideoElement) => {
        video.currentTime = 2;
      });

      await expect
        .poll(async () => seekedAt(await player.events(), 2), {
          message: 'the player sends a timeUpdate at 0:02, then seeked',
        })
        .toBe(true);
    });
  }

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

  for (const [what, tuning] of [
    ['', { appendBytes: 4096 }],
    [', past a full buffer', { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 }],
  ] as const) {
    test(`reaches a start position in a WebM without a Duration${what}`, async ({ page }) => {
      // Until the stream ends, MediaSource lets a WebM without a Duration seek only as far as it
      // has streamed. Small appends keep the end of the stream after the start seek.
      const player = await openPlayer(page, { tuning });

      await player.post(load({ videoUri: media.noDuration, startAt: 6, autoplay: false }));

      await expect
        .poll(async () => seekedAt(await player.events(), 6), {
          message: 'the player sends a timeUpdate at 0:06, then seeked',
        })
        .toBe(true);
      expect((await player.video()).currentTime).toBeCloseTo(6, 1);
      expect((await player.events()).map((event) => event.type)).not.toContain('error');
    });
  }

  // With the default 1 MB appends, `loadedmetadata` (which applies `startAt`) can come before the
  // end of the first append; held at a Cluster, only what is before it is buffered by then.
  for (const [what, cluster] of [
    ['before any of its media is buffered', 0],
    ['with only its first two seconds buffered', 2],
  ] as const) {
    test(`reaches a start position in a WebM without a Duration whose metadata comes ${what}`, async ({
      page,
    }) => {
      const player = await openPlayer(page, {
        holdAt: noDurationClusterOffset(cluster),
        metadataBeforeFirstAppendEnds: true,
      });
      await player.post(load({ videoUri: media.noDuration, startAt: 6, autoplay: false }));
      await expect.poll(async () => (await player.video()).duration).toBe(Infinity);

      await player.releaseStream();

      await expect
        .poll(async () => seekedAt(await player.events(), 6), {
          message: 'the player sends a timeUpdate at 0:06, then seeked',
        })
        .toBe(true);
      expect((await player.video()).currentTime).toBeCloseTo(6, 1);
      const types = (await player.events()).map((event) => event.type);
      expect(types.filter((type) => type === 'seeked')).toHaveLength(1);
      expect(types).not.toContain('error');
    });
  }

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

  // MediaSource also drops the video frames after a removal's end, up to the next keyframe, so
  // making room must not end a removal inside the group of pictures the playhead is in. The
  // keyframes of the 8 s fixture are at 0:00.003, 0:01.003, 0:02.003, …
  for (const [what, tuning, roomMade] of [
    [
      'keepBehindSeconds reaches into its group of pictures',
      // Full with 0:01.3 or more ahead; keepBehindSeconds alone would keep only from 0:02.3.
      { appendBytes: 2048, quotaSeconds: 3.8, keepBehindSeconds: 0.2 },
      4.4,
    ],
    [
      'less than a second is buffered ahead of it',
      // Full with less than 0:01 ahead, when everything behind the playhead may go.
      { appendBytes: 2048, quotaSeconds: 3.2 },
      3.6,
    ],
  ] as const) {
    test(`keeps the picture under a paused playhead when the buffer fills and ${what}`, async ({
      page,
    }) => {
      // Held at 0:02.988, so the start seek to 0:02.5 has landed before the buffer fills.
      const player = await openPlayer(page, { tuning, holdAt: longClusterOffset(3) });
      await player.post(load({ videoUri: media.long, startAt: 2.5, autoplay: false }));
      await expect
        .poll(async () => seekedAt(await player.events(), 2.5), {
          message: 'the player sends a timeUpdate at 0:02.5, then seeked',
        })
        .toBe(true);

      await player.releaseStream();

      // The buffer cannot reach this far without having made room once.
      await expect
        .poll(async () => (await player.video()).buffered.at(-1)?.[1] ?? 0)
        .toBeGreaterThan(roomMade);
      const video = await player.video();
      expect(video.currentTime).toBeCloseTo(2.5, 2);
      expect(
        video.buffered.some(([from, to]) => from <= video.currentTime && to > 3),
        `the picture at 0:02.5 is still buffered: ${JSON.stringify(video.buffered)}`,
      ).toBe(true);

      await player.post({ type: 'play' });
      await expect
        .poll(
          async () =>
            (await player.events()).some(
              (event) => event.type === 'timeUpdate' && event.position > 3.5 && event.position < 6,
            ),
          { message: 'the playhead plays on from 0:02.5', timeout: 10_000 },
        )
        .toBe(true);
    });
  }

  test('reaches a start position late in a group of pictures when the buffer fills before it', async ({
    page,
  }) => {
    // Held halfway through the Cluster at 0:05.984 (about 0:06.5), between the keyframe at
    // 0:06.003 and the 0:06.9 target; the buffer is full by then. Making room must keep that
    // keyframe, or the target can never be shown.
    const player = await openPlayer(page, {
      tuning: { quotaSeconds: 2 },
      holdAt: Math.round((longClusterOffset(6) + longClusterOffset(7)) / 2),
    });
    await player.post(load({ videoUri: media.long, startAt: 6.9, autoplay: false }));
    await expect
      .poll(async () => {
        const video = await player.video();
        return video.currentTime === 6.9 && (video.buffered.at(-1)?.[1] ?? 0) > 6.2;
      })
      .toBe(true);

    await player.releaseStream();

    await expect
      .poll(async () => seekedAt(await player.events(), 6.9), {
        message: 'the player sends a timeUpdate at 0:06.9, then seeked',
      })
      .toBe(true);
    const video = await player.video();
    expect(video.buffered.some(([from, to]) => from <= video.currentTime && to > 7.5)).toBe(true);
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

    test('steps forward past the buffered end of a WebM that states no length', async ({
      page,
    }) => {
      // The 3 s quota stops the stream before its end, as a Lesson larger than the MediaSource
      // quota does, so the file's length is still unknown (it has no Duration element).
      const player = await openPlayer(page, {
        tuning: { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 },
      });
      await player.post(load({ videoUri: media.noDuration, autoplay: false }));
      await expect
        .poll(async () => (await player.video()).buffered.at(-1)?.[1] ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(2.5);
      expect(Number.isFinite((await player.video()).duration)).toBe(false);

      await player.post({ type: 'seekBy', seconds: 5 });
      await player.post({ type: 'play' });

      await player.waitForEvent({ type: 'seeked', lessonId });
      await expect
        .poll(
          async () =>
            (await player.events()).some(
              (event) => event.type === 'timeUpdate' && event.position > 5.3,
            ),
          { message: 'the playhead plays on from 0:05', timeout: 10_000 },
        )
        .toBe(true);
      expect((await player.events()).map((event) => event.type)).not.toContain('error');
    });

    test('steps past the buffered end of a WebM that states no length, also when its header arrives in pieces', async ({
      page,
    }) => {
      // 64-byte appends: the first append ends before the header says whether there is a length.
      const player = await openPlayer(page, {
        tuning: { appendBytes: 64, quotaSeconds: 3, keepBehindSeconds: 0.5 },
      });
      await player.post(load({ videoUri: media.noDuration, autoplay: false }));
      await expect
        .poll(async () => (await player.video()).buffered.at(-1)?.[1] ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(2.5);

      await player.post({ type: 'seekBy', seconds: 5 });
      await player.post({ type: 'play' });

      await player.waitForEvent({ type: 'seeked', lessonId });
      await expect
        .poll(
          async () =>
            (await player.events()).some(
              (event) => event.type === 'timeUpdate' && event.position > 5.3,
            ),
          { message: 'the playhead plays on from 0:05', timeout: 20_000 },
        )
        .toBe(true);
    });

    test('stops at the end of a WebM that states no length once all of it has streamed', async ({
      page,
    }) => {
      const player = await openPlayer(page);
      await player.post(load({ videoUri: media.noDuration, autoplay: false }));
      await expect
        .poll(async () => Number.isFinite((await player.video()).duration), {
          message: 'the stream ended, so the length is known',
        })
        .toBe(true);
      const { duration } = await player.video();

      await player.post({ type: 'seekBy', seconds: 30 });

      await player.waitForEvent({ type: 'seeked', lessonId });
      expect((await player.video()).currentTime).toBe(duration);
    });

    test('adds up steps pressed in a row', async ({ page }) => {
      const player = await loadLong(page);

      await player.postAll([
        { type: 'seekBy', seconds: 2 },
        { type: 'seekBy', seconds: 2 },
        { type: 'seekBy', seconds: -1 },
      ]);

      await expect.poll(() => seekedCount(player)).toBeGreaterThan(0);
      await expect.poll(async () => (await player.video()).currentTime).toBeCloseTo(3, 1);
    });

    test('ignores a seekBy whose seconds are not a number', async ({ page }) => {
      const player = await loadLong(page);

      await page.evaluate(() => {
        window.postMessage({ type: 'seekBy', seconds: '5' }, '*');
        window.postMessage({ type: 'seekBy', seconds: Number.NaN }, '*');
        window.postMessage({ type: 'seekBy' }, '*');
      });
      await player.post({ type: 'seekBy', seconds: 1 });

      // Only the well-formed step after them moves the playhead.
      await player.waitForEvent({ type: 'seeked', lessonId });
      expect((await player.video()).currentTime).toBeCloseTo(1, 1);
      expect(await seekedCount(player)).toBe(1);
    });

    test('steps again while the re-stream of an earlier step is under way', async ({ page }) => {
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

      // Back past the dropped media, then back again before that re-stream is done.
      await player.postAll([
        { type: 'seekBy', seconds: -3 },
        { type: 'seekBy', seconds: -2 },
        { type: 'play' },
      ]);

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

    test('a long forward step on a WebM that states no length ends at its end', async ({
      page,
    }) => {
      const player = await openPlayer(page, {
        tuning: { appendBytes: 4096, quotaSeconds: 3, keepBehindSeconds: 0.5 },
      });
      await player.post(load({ videoUri: media.noDuration, autoplay: false }));
      await expect
        .poll(async () => (await player.video()).buffered.at(-1)?.[1] ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(2.5);

      // Further than the Lesson is long, while its end is still unknown.
      await player.post({ type: 'seekBy', seconds: 60 });
      await player.post({ type: 'play' });

      await player.waitForEvent({ type: 'ended', lessonId });
      expect((await player.video()).currentTime).toBeCloseTo(8, 0);
      expect((await player.events()).map((event) => event.type)).not.toContain('error');
    });

    test('waits for the running stream, instead of re-streaming, when stepping ahead of it', async ({
      page,
    }) => {
      // Held 100 bytes before the Cluster at 0:02.988: once released, the player reads the rest
      // of the file, Clusters 0:02.988–0:06.982 with it, and appends it only after making room.
      const player = await openPlayer(page, {
        tuning: { quotaSeconds: 2.5 },
        holdAt: longClusterOffset(3) - 100,
      });
      await player.post(load({ videoUri: media.long, autoplay: false }));
      await expect
        .poll(async () => (await player.video()).buffered.at(-1)?.[1] ?? 0)
        .toBeGreaterThan(2.5);
      await player.releaseStream();

      // 0:06 is in what the running stream has read but not yet appended.
      await player.post({ type: 'seekBy', seconds: 6 });

      await player.waitForEvent({ type: 'seeked', lessonId });
      expect((await player.video()).currentTime).toBeCloseTo(6, 1);
      expect(player.rangeRequests()).toEqual([]);
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

  test.describe('setRate', () => {
    test('sets the playback rate and reports rateChanged', async ({ page }) => {
      const player = await openPlayer(page);
      await player.post(load({ videoUri: media.webm, autoplay: false }));

      await player.post({ type: 'setRate', rate: 1.5 });

      await player.waitForEvent({ type: 'rateChanged', lessonId, rate: 1.5 });
      expect((await player.video()).playbackRate).toBe(1.5);
    });

    test('works for an MP4 Lesson, and while it plays', async ({ page }) => {
      const player = await openPlayer(page);
      await player.post(load({ videoUri: media.mp4, container: 'mp4', autoplay: true }));
      await player.waitForEvent({ type: 'played', lessonId });

      await player.post({ type: 'setRate', rate: 0.75 });

      await player.waitForEvent({ type: 'rateChanged', lessonId, rate: 0.75 });
      expect((await player.video()).playbackRate).toBe(0.75);
      expect((await player.video()).paused).toBe(false);
    });

    test('keeps the rate for the next Lesson', async ({ page }) => {
      const player = await openPlayer(page);
      await player.post(load({ videoUri: media.webm, autoplay: false }));
      await player.post({ type: 'setRate', rate: 2 });
      await player.waitForEvent({ type: 'rateChanged', lessonId, rate: 2 });

      await player.post(
        load({ lessonId: 'second.mp4', videoUri: media.mp4, container: 'mp4', autoplay: false }),
      );
      await player.waitForEvent({ type: 'timeUpdate', lessonId: 'second.mp4' });

      expect((await player.video()).playbackRate).toBe(2);
      await player.post(load({ videoUri: media.webm, autoplay: false }));
      await expect.poll(async () => (await player.video()).currentSrc).not.toBe('');
      expect((await player.video()).playbackRate).toBe(2);
    });

    test('reports a rate the extension did not set', async ({ page }) => {
      const player = await openPlayer(page);
      await player.post(load({ videoUri: media.webm, autoplay: false }));

      await page.locator('video').evaluate((element: HTMLVideoElement) => {
        element.playbackRate = 1.25;
      });

      await player.waitForEvent({ type: 'rateChanged', lessonId, rate: 1.25 });
    });

    test('ignores a setRate whose rate is not a positive number', async ({ page }) => {
      const player = await openPlayer(page);
      await player.post(load({ videoUri: media.webm, autoplay: false }));
      await page.evaluate(() => {
        window.postMessage({ type: 'setRate', rate: '2' }, '*');
        window.postMessage({ type: 'setRate', rate: 0 }, '*');
        window.postMessage({ type: 'setRate', rate: -1 }, '*');
        window.postMessage({ type: 'setRate', rate: Number.NaN }, '*');
        window.postMessage({ type: 'setRate' }, '*');
      });
      await player.post({ type: 'setRate', rate: 1.25 });
      await player.waitForEvent({ type: 'rateChanged', lessonId, rate: 1.25 });

      expect((await player.video()).playbackRate).toBe(1.25);
      expect((await player.events()).filter((event) => event.type === 'rateChanged')).toHaveLength(
        1,
      );
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
