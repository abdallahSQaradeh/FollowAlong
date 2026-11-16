/**
 * Seam 2: the player page in the mini strip (ADR 0100). The strip is a short, wide editor group
 * above the code, so the page is much wider than the picture. Zoom, the toolbar and the click on
 * the picture have to work in that shape, and a zoom restored from a page of another shape shows
 * the same area of the picture.
 */
import type { Page } from '@playwright/test';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, type PlayerHarness } from './player-page.js';

const lessonId = 'Section 1/01 Welcome.webm';

/** About a quarter of a 27" editor area high, and the whole width of it. */
const strip = { width: 1000, height: 200 } as const;

function load(overrides: Partial<Extract<PlayerCommand, { type: 'load' }>> = {}): PlayerCommand {
  return {
    type: 'load',
    lessonId,
    videoUri: media.long,
    container: 'webm',
    startAt: 0,
    autoplay: false,
    ...overrides,
  };
}

async function loadPaused(player: PlayerHarness): Promise<void> {
  await player.post(load());
  await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
}

/** The part of the player the page shows now, as fractions of it (`{0, 0, 1, 1}` at 1×). */
async function shownArea(page: Page): Promise<Record<'left' | 'top' | 'width' | 'height', number>> {
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
      height: window.innerHeight / box.height,
    };
  });
}

function toolbar(page: Page) {
  return page.getByRole('toolbar', { name: 'Zoom' });
}

test.describe('the player in the mini strip', () => {
  test.use({ viewport: strip });

  test('zooms to a box dragged over the picture, and reports the level', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    // A box 100 px wide and 100 px high, over the middle of the picture.
    await page.mouse.move(450, 50);
    await page.mouse.down();
    await page.mouse.move(550, 150, { steps: 8 });
    await page.mouse.up();

    // The taller side of the box is half the strip: 2×, centred on the box.
    await player.waitForEvent({ type: 'zoomChanged', level: 2 });
    const area = await shownArea(page);
    expect(area.width).toBeCloseTo(0.5, 2);
    expect(area.height).toBeCloseTo(0.5, 2);
    expect(area.left).toBeCloseTo(0.25, 2);
    expect(area.top).toBeCloseTo(0.25, 2);
  });

  test('shows the zoom toolbar inside the strip, and ＋ zooms in 1.25× around the middle', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    const box = await toolbar(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(strip.height);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(strip.width);

    await toolbar(page).getByRole('button', { name: 'Zoom in' }).click();

    await player.waitForEvent({ type: 'zoomChanged', level: 1.25 });
    await expect(toolbar(page).getByLabel('Zoom level')).toHaveText('1.3×');
  });

  test('zooms in toward the cursor with the wheel', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await page.mouse.move(500, 100);
    await page.mouse.wheel(0, -100);

    await player.waitForEvent({ type: 'zoomChanged', level: 1.25 });
    // What is under the cursor stays under it: the middle of the strip stays in the middle.
    const area = await shownArea(page);
    expect(area.left + area.width / 2).toBeCloseTo(0.5, 2);
  });

  test('a click on the picture plays, and the next one pauses', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await page.mouse.click(500, 60);
    await player.waitForEvent({ type: 'played', lessonId });

    await page.mouse.click(500, 60);
    await player.waitForEvent({ type: 'paused', lessonId, byUser: true });
  });

  test('takes the zoom of a page of another shape, and shows the same area', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load({ startAt: 2 }));

    // A snapshot taken in the editor group beside the code, 4× on the lower right quarter.
    await player.post({ type: 'restore', zoom: { level: 4, left: 0.5, top: 0.5 } });

    await player.waitForEvent({ type: 'zoomChanged', level: 4 });
    const area = await shownArea(page);
    expect(area.left).toBeCloseTo(0.5, 2);
    expect(area.top).toBeCloseTo(0.5, 2);
    expect(area.width).toBeCloseTo(0.25, 2);
    await expect(toolbar(page).getByLabel('Zoom level')).toHaveText('4×');
  });
});
