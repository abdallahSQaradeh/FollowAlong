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

test.describe('while zoomed', () => {
  test('the native control bar is off, since it would be enlarged with the picture', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    expect((await player.video()).controls).toBe(true);

    await drag(page, { x: 320, y: 180 }, { x: 640, y: 360 });
    await player.waitForEvent({ type: 'zoomChanged', level: 4 });

    expect((await player.video()).controls).toBe(false);
  });
});

/** The player with the Lesson loaded and paused, zoomed 4× to the box of the first test. */
async function zoomedPaused(page: Page, options: { userGestures?: boolean } = {}) {
  const player = await openPlayer(page, options);
  await loadPaused(player);
  await drag(page, { x: 320, y: 180 }, { x: 640, y: 360 });
  await player.waitForEvent({ type: 'zoomChanged', level: 4 });
  // The drag's own report comes a task after its zoom: count from after it.
  await expect.poll(() => interactions(player)).toBe(1);
  return player;
}

function count(events: readonly PlayerEvent[], type: PlayerEvent['type']): number {
  return events.filter((event) => event.type === type).length;
}

test.describe('a double-click while zoomed', () => {
  test('resets the zoom, without playing or pausing the Lesson', async ({ page }) => {
    const player = await zoomedPaused(page);

    await page.mouse.dblclick(600, 300);

    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
    expect((await player.video()).controls).toBe(true);
    await page.waitForTimeout(600);
    expect((await player.video()).paused).toBe(true);
    expect(count(await player.events(), 'played')).toBe(0);
  });
});

test.describe('a click while zoomed', () => {
  test('plays the Lesson once the double-click window has passed, and hands focus back', async ({
    page,
  }) => {
    const player = await zoomedPaused(page);
    const before = await interactions(player);

    await page.mouse.click(600, 300);

    await player.waitForEvent({ type: 'played', lessonId });
    await page.waitForTimeout(600);
    const events = await player.events();
    expect(count(events, 'played')).toBe(1);
    expect(count(events, 'paused')).toBe(0);
    expect(await interactions(player)).toBe(before + 1);
    expect(events.at(-1)).not.toMatchObject({ type: 'zoomChanged' });
  });

  test('on the strip along the bottom plays too: the control bar is off', async ({ page }) => {
    const player = await zoomedPaused(page);

    await page.mouse.click(640, 715);

    await player.waitForEvent({ type: 'played', lessonId });
  });

  test('alone starts a Lesson whose autoplay VS Code refused, on a page that kept its zoom (#12 D3)', async ({
    page,
  }) => {
    const player = await zoomedPaused(page, { userGestures: false });
    // A new page: the drag's user activation is gone, the zoom is not.
    await page.reload();
    await player.waitForEvent({ type: 'zoomChanged', level: 4 });
    await player.post(load({ autoplay: true }));
    await player.waitForEvent({ type: 'paused', lessonId, byUser: false });
    expect((await player.video()).controls).toBe(false);

    await page.mouse.click(600, 300);

    await player.waitForEvent({ type: 'played', lessonId });
  });

  test('starts a Lesson whose autoplay VS Code refused (#12 D3)', async ({ page }) => {
    const player = await openPlayer(page, { userGestures: false });
    await player.post(load({ autoplay: true }));
    await player.waitForEvent({ type: 'paused', lessonId, byUser: false });
    await drag(page, { x: 320, y: 180 }, { x: 640, y: 360 });
    await player.waitForEvent({ type: 'zoomChanged', level: 4 });

    await page.mouse.click(600, 300);

    await player.waitForEvent({ type: 'played', lessonId });
  });
});

test.describe('the zoom toolbar', () => {
  function toolbar(page: Page) {
    return page.getByRole('toolbar', { name: 'Zoom' });
  }

  function level(page: Page) {
    return toolbar(page).getByLabel('Zoom level');
  }

  test('shows the level, 1× until the learner zooms', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    await expect(level(page)).toHaveText('1×');

    await drag(page, { x: 320, y: 180 }, { x: 640, y: 360 });

    await expect(level(page)).toHaveText('4×');
  });

  test('＋ and − zoom in and out around the middle, 1.25× a press, from 1× up to 8×', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    const zoomIn = toolbar(page).getByRole('button', { name: 'Zoom in' });
    const zoomOut = toolbar(page).getByRole('button', { name: 'Zoom out' });

    await zoomIn.click();
    await player.waitForEvent({ type: 'zoomChanged', level: 1.25 });
    await expect(level(page)).toHaveText('1.3×');
    expectArea(await shownArea(page), { left: 0.1, top: 0.1, width: 0.8, height: 0.8 });

    await zoomOut.click();
    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    await expect(level(page)).toHaveText('1×');
    await zoomOut.click();
    await expect(level(page)).toHaveText('1×');

    for (let press = 0; press < 12; press += 1) {
      await zoomIn.click();
    }
    await expect(level(page)).toHaveText('8×');
    await player.waitForEvent({ type: 'zoomChanged', level: 8 });
  });

  test('reset shows the whole picture again', async ({ page }) => {
    const player = await zoomedPaused(page);

    await toolbar(page).getByRole('button', { name: 'Reset zoom' }).click();

    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
    expect((await player.video()).controls).toBe(true);
  });

  test('area mode lasts until the next box, which zooms', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    const area = toolbar(page).getByRole('button', { name: 'Zoom to an area' });

    await area.click();
    await expect(area).toHaveAttribute('aria-pressed', 'true');
    await area.click();
    await expect(area).toHaveAttribute('aria-pressed', 'false');
    await area.click();

    await drag(page, { x: 320, y: 180 }, { x: 640, y: 360 });

    await player.waitForEvent({ type: 'zoomChanged', level: 4 });
    await expect(area).toHaveAttribute('aria-pressed', 'false');
  });

  test('buttons neither play nor pause, and hand focus back after each press', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    for (const name of ['Zoom in', 'Zoom out', 'Zoom to an area', 'Reset zoom']) {
      await toolbar(page).getByRole('button', { name }).click();
    }

    await expect.poll(() => interactions(player)).toBe(4);
    await page.waitForTimeout(600);
    expect(await interactions(player)).toBe(4);
    expect((await player.video()).paused).toBe(true);
  });
});

test.describe('the zoom', () => {
  test('stays while the Lesson plays, and when another Lesson loads', async ({ page }) => {
    const player = await zoomedPaused(page);

    await player.post({ type: 'play' });
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(1);
    expectArea(await shownArea(page), { left: 0.25, top: 0.25, width: 0.25, height: 0.25 });

    await player.post({
      type: 'load',
      lessonId: 'Section 1/02 Setup.mp4',
      videoUri: media.mp4,
      container: 'mp4',
      startAt: 0,
      autoplay: true,
    });
    await player.waitForEvent({ type: 'played', lessonId: 'Section 1/02 Setup.mp4' });

    expectArea(await shownArea(page), { left: 0.25, top: 0.25, width: 0.25, height: 0.25 });
    expect((await player.video()).controls).toBe(false);
    expect((await player.events()).filter((event) => event.type === 'zoomChanged')).toEqual([
      { type: 'zoomChanged', level: 4 },
    ]);
  });

  test('survives a reload of the page, and the new page reports it after ready', async ({
    page,
  }) => {
    await zoomedPaused(page);

    // VS Code reloads the page when the player's folders change (ADR 0022).
    await page.reload();

    await expect
      .poll(() => page.evaluate(() => window.followalongSent))
      .toEqual([
        { type: 'ready', aacSupported: true },
        { type: 'zoomChanged', level: 4 },
      ]);
    expectArea(await shownArea(page), { left: 0.25, top: 0.25, width: 0.25, height: 0.25 });
    await expect(page.getByLabel('Zoom level')).toHaveText('4×');
  });

  test('a page that starts at 1× reports no zoom', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await page.reload();
    await player.waitForEvent({ type: 'ready' });
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => window.followalongSent)).toEqual([
      { type: 'ready', aacSupported: true },
    ]);
  });
});

test.describe('the zoom reset command', () => {
  test('shows the whole picture again, as the status bar item asks', async ({ page }) => {
    const player = await zoomedPaused(page);

    await player.post({ type: 'zoom', action: 'reset' });

    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
    expect((await player.video()).controls).toBe(true);
    await expect(page.getByLabel('Zoom level')).toHaveText('1×');
  });
});

test.describe('area mode', () => {
  function areaButton(page: Page) {
    return page.getByRole('toolbar', { name: 'Zoom' }).getByRole('button', {
      name: 'Zoom to an area',
    });
  }

  test('ends after the next drag, even one too small to zoom', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    await areaButton(page).click();

    await drag(page, { x: 320, y: 180 }, { x: 330, y: 184 });

    await expect(areaButton(page)).toHaveAttribute('aria-pressed', 'false');
    expect((await player.events()).some((event) => event.type === 'zoomChanged')).toBe(false);
  });

  test('ends with a reset', async ({ page }) => {
    const player = await zoomedPaused(page);
    await areaButton(page).click();

    await player.post({ type: 'zoom', action: 'reset' });

    await expect(areaButton(page)).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('a box drag that does not end normally', () => {
  test('still lets the next click on the picture hand focus back when it lost the pointer', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    await page.mouse.move(320, 180);
    await page.mouse.down();
    await page.mouse.move(640, 360, { steps: 8 });
    // The browser takes the pointer away (a window blur, say): no pointerup reaches the picture.
    await page.evaluate(() => {
      const overlay = document.querySelector('.overlay');
      for (let pointerId = 0; pointerId < 4; pointerId += 1) {
        if (overlay?.hasPointerCapture(pointerId) === true) {
          overlay.releasePointerCapture(pointerId);
        }
      }
    });
    const toolbar = await page.getByRole('toolbar', { name: 'Zoom' }).boundingBox();
    if (toolbar === null) {
      throw new Error('the zoom toolbar is not on screen');
    }
    await page.mouse.move(toolbar.x + 2, toolbar.y + 2);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const before = await interactions(player);

    await page.mouse.click(600, 300);

    await expect.poll(() => interactions(player)).toBe(before + 1);
    expect((await player.events()).some((event) => event.type === 'zoomChanged')).toBe(false);
  });

  test('zooms nothing when a reset comes while the box is drawn', async ({ page }) => {
    const player = await zoomedPaused(page);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 8 });

    await player.post({ type: 'zoom', action: 'reset' });
    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
    await expect(page.locator('.zoom-box')).toBeHidden();
    expect((await player.video()).paused).toBe(true);
  });
});

test.describe('a box that covers almost the whole picture', () => {
  test('does not zoom: a level that reads 1× is the whole picture', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await drag(page, { x: 5, y: 5 }, { x: 1275, y: 640 });
    await expect.poll(() => interactions(player)).toBe(1);

    expect((await player.events()).some((event) => event.type === 'zoomChanged')).toBe(false);
    expect((await player.video()).controls).toBe(true);
    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
  });
});

test.describe('a double-click at 1×', () => {
  test('leaves area mode on: there is no zoom to reset', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    const area = page
      .getByRole('toolbar', { name: 'Zoom' })
      .getByRole('button', { name: 'Zoom to an area' });
    await area.click();

    await page.mouse.dblclick(600, 300);

    await expect(area).toHaveAttribute('aria-pressed', 'true');
  });
});
