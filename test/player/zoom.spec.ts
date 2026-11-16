import type { Page } from '@playwright/test';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
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
    ...overrides,
  };
}

/** Loads the Lesson without autoplay, and waits until its length is known. */
async function loadPaused(player: PlayerHarness): Promise<void> {
  await player.post(load());
  await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
}

async function interactions(player: PlayerHarness): Promise<number> {
  return (await player.events()).filter((event) => event.type === 'userInteracted').length;
}

interface Area {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The part of the whole picture the player shows now, as fractions of it: `{0, 0, 1, 1}` at 1×.
 * Read from where the (scaled) video lies relative to the page, which is what the learner sees.
 */
async function shownArea(page: Page): Promise<Area> {
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

function expectArea(actual: Area, expected: Area): void {
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    expect(actual[key], key).toBeCloseTo(expected[key], 2);
  }
}

/** Drags with the mouse from one point of the page to another, in small steps. */
async function drag(
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.describe('dragging a box on the picture', () => {
  // 1280 × 720 (Desktop Chrome): the picture fills the page exactly.
  test('zooms to the area in the box, and reports the zoom level', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });

    // A quarter of the width and of the height, starting a quarter in.
    await drag(page, { x: 320, y: 180 }, { x: 640, y: 360 });

    await player.waitForEvent({ type: 'zoomChanged', level: 4 });
    expectArea(await shownArea(page), { left: 0.25, top: 0.25, width: 0.25, height: 0.25 });
  });
});

test.describe('a zoom drag', () => {
  test('does not play or pause the Lesson, as a click would', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await drag(page, { x: 320, y: 180 }, { x: 640, y: 360 });
    await player.waitForEvent({ type: 'zoomChanged', level: 4 });
    await page.waitForTimeout(500);

    expect((await player.video()).paused).toBe(true);
    expect((await player.events()).some((event) => event.type === 'played')).toBe(false);
  });

  test('keeps focus while the box is drawn, and hands it back once when let go', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await page.mouse.move(320, 180);
    await page.mouse.down();
    await page.mouse.move(640, 360, { steps: 8 });
    await page.waitForTimeout(300);
    expect(await interactions(player)).toBe(0);

    await page.mouse.up();

    await player.waitForEvent({ type: 'userInteracted' });
    await page.waitForTimeout(300);
    expect(await interactions(player)).toBe(1);
  });
});
