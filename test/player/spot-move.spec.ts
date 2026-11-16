/**
 * Seam 2: what the player page does for a move to another spot (ADR 0049). The page the video
 * leaves answers `takeSnapshot`; the page in the new spot gets a `load` at the snapshot's playhead
 * and a `restore` of its zoom.
 */
import type { Page } from '@playwright/test';

import type { PlayerCommand, PlayerEvent } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, type PlayerHarness } from './player-page.js';

const lessonId = 'Section 1/01 Welcome.webm';

function load(overrides: Partial<Extract<PlayerCommand, { type: 'load' }>> = {}): PlayerCommand {
  return {
    type: 'load',
    lessonId,
    videoUri: media.long,
    container: 'webm',
    startAt: 0,
    autoplay: false,
    loadId: 7,
    ...overrides,
  };
}

/** The `snapshot` the page sent last. */
async function lastSnapshot(
  player: PlayerHarness,
): Promise<Extract<PlayerEvent, { type: 'snapshot' }>['snapshot'] | undefined> {
  await player.waitForEvent({ type: 'snapshot' });
  return (await player.events()).findLast((event) => event.type === 'snapshot')?.snapshot;
}

/** The part of the whole picture the page shows, as fractions of it (`{0, 0, 1, 1}` at 1×). */
async function shownArea(page: Page): Promise<Record<'left' | 'top' | 'width', number>> {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    if (video === null) {
      throw new Error('The player page has no <video> element.');
    }
    const box = video.getBoundingClientRect();
    return {
      left: -box.x / box.width,
      top: -box.y / box.height,
      width: window.innerWidth / box.width,
    };
  });
}

test.describe('takeSnapshot', () => {
  test('answers with the playhead, play state, speed and zoom of a playing Lesson', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await player.postAll([
      load({ autoplay: true }),
      { type: 'setRate', rate: 1.5 },
      { type: 'restore', zoom: { level: 2, left: 0.25, top: 0.5 } },
    ]);
    await player.waitForEvent({ type: 'played', lessonId });
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(0.5);

    await player.post({ type: 'takeSnapshot' });

    const snapshot = await lastSnapshot(player);
    expect(snapshot).toMatchObject({
      rate: 1.5,
      zoom: { level: 2, left: 0.25, top: 0.5 },
      lesson: { lessonId, loadId: 7, playing: true },
    });
    const { currentTime } = await player.video();
    expect(snapshot?.lesson?.position).toBeGreaterThan(0.5);
    expect(snapshot?.lesson?.position).toBeLessThanOrEqual(currentTime);
  });

  test('gives the start position of a Lesson whose start seek has not happened yet', async ({
    page,
  }) => {
    const player = await openPlayer(page);

    await player.postAll([load({ startAt: 5 }), { type: 'takeSnapshot' }]);

    expect(await lastSnapshot(player)).toEqual({
      rate: 1,
      zoom: { level: 1, left: 0, top: 0 },
      lesson: { lessonId, loadId: 7, position: 5, playing: false },
    });
  });

  test('answers without a Lesson when the page holds none', async ({ page }) => {
    const player = await openPlayer(page);

    await player.post({ type: 'takeSnapshot' });

    expect(await lastSnapshot(player)).toEqual({ rate: 1, zoom: { level: 1, left: 0, top: 0 } });
  });
});

test.describe('restore', () => {
  test('shows the area the page before showed, and reports its level', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load({ startAt: 2 }));

    await player.post({ type: 'restore', zoom: { level: 4, left: 0.25, top: 0.5 } });

    await player.waitForEvent({ type: 'zoomChanged', level: 4 });
    const area = await shownArea(page);
    expect(area.left).toBeCloseTo(0.25, 2);
    expect(area.top).toBeCloseTo(0.5, 2);
    expect(area.width).toBeCloseTo(0.25, 2);
    await expect(page.getByLabel('Zoom level')).toHaveText('4×');
    expect((await player.video()).controls).toBe(false);
  });

  test('is kept by the page, like a zoom the learner made', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post({ type: 'restore', zoom: { level: 4, left: 0.25, top: 0.5 } });
    await player.waitForEvent({ type: 'zoomChanged', level: 4 });

    await page.reload();

    await expect(page.getByLabel('Zoom level')).toHaveText('4×');
  });
});

test.describe('restore at the whole picture', () => {
  test('undoes a zoom the page kept from the page it held before in this spot', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await player.post({ type: 'restore', zoom: { level: 4, left: 0.25, top: 0.5 } });
    await player.waitForEvent({ type: 'zoomChanged', level: 4 });
    // A view spot used before: its new page starts with that page's zoom in its webview state.
    await page.reload();
    await expect(page.getByLabel('Zoom level')).toHaveText('4×');

    await player.post({ type: 'restore', zoom: { level: 1, left: 0, top: 0 } });

    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    expect((await shownArea(page)).width).toBeCloseTo(1, 2);
  });
});
