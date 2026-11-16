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

test.describe('a plain drag while zoomed', () => {
  test('pans: the picture follows the pointer, and the level stays', async ({ page }) => {
    const player = await zoomedPaused(page);

    // 200 px left and 100 px up: the picture moves with the pointer, so the shown area moves right
    // and down by that much of the player (1/4 of the picture is shown, 4× from 1/4 in).
    await drag(page, { x: 600, y: 300 }, { x: 400, y: 200 });

    expectArea(await shownArea(page), {
      left: 0.25 + (200 / 1280) * 0.25,
      top: 0.25 + (100 / 720) * 0.25,
      width: 0.25,
      height: 0.25,
    });
    await expect(page.getByLabel('Zoom level')).toHaveText('4×');
    await page.waitForTimeout(300);
    expect((await player.events()).filter((event) => event.type === 'zoomChanged')).toHaveLength(1);
  });

  test('stops at the edges of the picture', async ({ page }) => {
    await zoomedPaused(page);

    // Each drag moves the shown area by 1260/1280 of a quarter (0.246): three reach the bottom
    // right from a quarter in (0.25 + 0.738), and four reach the top left again from there.
    for (let repeat = 0; repeat < 3; repeat += 1) {
      await drag(page, { x: 1270, y: 700 }, { x: 10, y: 20 });
    }
    expectArea(await shownArea(page), { left: 0.75, top: 0.75, width: 0.25, height: 0.25 });

    for (let repeat = 0; repeat < 4; repeat += 1) {
      await drag(page, { x: 10, y: 20 }, { x: 1270, y: 700 });
    }
    expectArea(await shownArea(page), { left: 0, top: 0, width: 0.25, height: 0.25 });
  });

  test('is not a click: it neither plays nor pauses, and hands focus back once', async ({
    page,
  }) => {
    const player = await zoomedPaused(page);
    const before = await interactions(player);

    await drag(page, { x: 600, y: 300 }, { x: 400, y: 200 });
    await page.waitForTimeout(600);

    expect((await player.video()).paused).toBe(true);
    const events = await player.events();
    expect(count(events, 'played')).toBe(0);
    expect(count(events, 'paused')).toBe(0);
    expect(await interactions(player)).toBe(before + 1);
  });

  test('keeps its place when the page reloads', async ({ page }) => {
    await zoomedPaused(page);
    await drag(page, { x: 600, y: 300 }, { x: 400, y: 200 });
    const panned = await shownArea(page);

    await page.reload();
    await expect(page.getByLabel('Zoom level')).toHaveText('4×');

    expectArea(await shownArea(page), panned);
  });
});

/** Drags with Shift held, as a learner drawing a box while zoomed does. */
async function shiftDrag(
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<void> {
  await page.keyboard.down('Shift');
  await drag(page, from, to);
  await page.keyboard.up('Shift');
}

test.describe('the cursor over the picture', () => {
  async function cursor(page: Page): Promise<string> {
    return page.locator('.overlay').evaluate((overlay) => getComputedStyle(overlay).cursor);
  }

  test('is a hand while zoomed, which closes during a pan, and a crosshair in area mode', async ({
    page,
  }) => {
    await zoomedPaused(page);
    expect(await cursor(page)).toBe('grab');

    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(500, 250, { steps: 4 });
    expect(await cursor(page)).toBe('grabbing');
    await page.mouse.up();
    expect(await cursor(page)).toBe('grab');

    await page.getByRole('button', { name: 'Zoom to an area' }).click();
    expect(await cursor(page)).toBe('crosshair');
  });
});

test.describe('a Shift+drag while zoomed', () => {
  test('draws a box and zooms to the area in it, instead of panning', async ({ page }) => {
    const player = await zoomedPaused(page);

    // The middle half of the player in each direction: of the quarter shown, its middle half.
    await shiftDrag(page, { x: 320, y: 180 }, { x: 960, y: 540 });

    await player.waitForEvent({ type: 'zoomChanged', level: 8 });
    expectArea(await shownArea(page), { left: 0.3125, top: 0.3125, width: 0.125, height: 0.125 });
  });

  test('is not a click, and hands focus back once', async ({ page }) => {
    const player = await zoomedPaused(page);
    const before = await interactions(player);

    await shiftDrag(page, { x: 320, y: 180 }, { x: 960, y: 540 });
    await player.waitForEvent({ type: 'zoomChanged', level: 8 });
    await page.waitForTimeout(600);

    expect((await player.video()).paused).toBe(true);
    expect(count(await player.events(), 'played')).toBe(0);
    expect(await interactions(player)).toBe(before + 1);
  });
});

/** Turns the wheel with the pointer at (`x`, `y`) of the page. */
async function wheel(page: Page, at: { readonly x: number; readonly y: number }, deltaY: number) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, deltaY);
}

test.describe('the wheel', () => {
  test('zooms in toward the cursor, 1.25× a notch, and out again to the whole picture', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    // The point a quarter in each way stays where it is under the cursor.
    await wheel(page, { x: 320, y: 180 }, -100);

    await player.waitForEvent({ type: 'zoomChanged', level: 1.25 });
    expectArea(await shownArea(page), { left: 0.05, top: 0.05, width: 0.8, height: 0.8 });
    await expect(page.getByLabel('Zoom level')).toHaveText('1.3×');
    expect((await player.video()).controls).toBe(false);

    await wheel(page, { x: 320, y: 180 }, 100);

    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
    expect((await player.video()).controls).toBe(true);
  });

  test('zooms toward a point near the picture’s edge, which stays where it is', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    // At 1× the picture ends 72 px above the bottom, where the control bar is: 640 of 720 px is
    // 8/9 of the way down, and a fifth of the zoomed-out part (0.2) lies above it and 8/9 of that
    // is 0.1778.
    await wheel(page, { x: 1279, y: 640 }, -100);

    await player.waitForEvent({ type: 'zoomChanged', level: 1.25 });
    expectArea(await shownArea(page), { left: 0.2, top: 0.17778, width: 0.8, height: 0.8 });
  });

  test('zooms out of a zoomed picture toward the cursor, inside the picture', async ({ page }) => {
    const player = await zoomedPaused(page);

    // The point under (320, 180) is 0.3125 in; 4× out to 3.2×.
    await wheel(page, { x: 320, y: 180 }, 100);

    await player.waitForEvent({ type: 'zoomChanged', level: 3.2 });
    expectArea(await shownArea(page), {
      left: 0.234375,
      top: 0.234375,
      width: 0.3125,
      height: 0.3125,
    });
  });

  test('stops at 8×, and zooming out stops at the whole picture', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await wheel(page, { x: 1279, y: 640 }, -2000);
    await player.waitForEvent({ type: 'zoomChanged', level: 8 });
    // Eight of 9 down, and 1/8 of the picture shown: 8/9 - 8/9 / 8.
    expectArea(await shownArea(page), { left: 0.875, top: 0.77778, width: 0.125, height: 0.125 });

    await wheel(page, { x: 1279, y: 640 }, -500);
    await page.waitForTimeout(300);
    expect((await player.events()).filter((event) => event.type === 'zoomChanged')).toHaveLength(1);

    await wheel(page, { x: 1279, y: 640 }, 5000);
    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
  });

  test('adds small turns of a trackpad up to a step, and forgets a turn left alone', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    await page.mouse.move(640, 360);

    for (let turn = 0; turn < 9; turn += 1) {
      await page.mouse.wheel(0, -10);
    }
    await page.waitForTimeout(300);
    expect((await player.events()).some((event) => event.type === 'zoomChanged')).toBe(false);

    // Nine turns long ago do not count: ten more are one step, not two.
    for (let turn = 0; turn < 10; turn += 1) {
      await page.mouse.wheel(0, -10);
    }
    await player.waitForEvent({ type: 'zoomChanged', level: 1.25 });
    await page.waitForTimeout(300);
    expect((await player.events()).filter((event) => event.type === 'zoomChanged')).toHaveLength(1);
  });

  test('neither plays nor pauses the Lesson, and does not take focus from the editor', async ({
    page,
  }) => {
    const player = await zoomedPaused(page);
    const before = await interactions(player);

    await wheel(page, { x: 600, y: 300 }, -100);
    await player.waitForEvent({ type: 'zoomChanged', level: 5 });
    await page.waitForTimeout(600);

    expect((await player.video()).paused).toBe(true);
    expect(count(await player.events(), 'played')).toBe(0);
    expect(await interactions(player)).toBe(before);
  });
});

test.describe('the wheel during a drag', () => {
  test('changes nothing: the drag keeps its view', async ({ page }) => {
    const player = await zoomedPaused(page);
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(400, 200, { steps: 8 });

    await page.mouse.wheel(0, -300);
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect((await player.events()).filter((event) => event.type === 'zoomChanged')).toHaveLength(1);
    await expect(page.getByLabel('Zoom level')).toHaveText('4×');
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
        { type: 'ready', aacSupported: true, soundCodecs: expect.any(Array) },
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
      { type: 'ready', aacSupported: true, soundCodecs: expect.any(Array) },
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

  test('makes a plain drag draw a box while zoomed, and then ends', async ({ page }) => {
    const player = await zoomedPaused(page);
    await areaButton(page).click();

    await drag(page, { x: 320, y: 180 }, { x: 960, y: 540 });

    await player.waitForEvent({ type: 'zoomChanged', level: 8 });
    expectArea(await shownArea(page), { left: 0.3125, top: 0.3125, width: 0.125, height: 0.125 });
    await expect(areaButton(page)).toHaveAttribute('aria-pressed', 'false');

    // Area mode is over: the next plain drag pans.
    await drag(page, { x: 600, y: 300 }, { x: 400, y: 200 });
    await expect(page.getByLabel('Zoom level')).toHaveText('8×');
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
    await page.keyboard.down('Shift');
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 8 });
    await page.keyboard.up('Shift');

    await player.post({ type: 'zoom', action: 'reset' });
    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
    await expect(page.locator('.zoom-box')).toBeHidden();
    expect((await player.video()).paused).toBe(true);
  });
});

test.describe('a pan that a reset interrupts', () => {
  test('ends: the release that follows moves nothing and does not play', async ({ page }) => {
    const player = await zoomedPaused(page);
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(400, 200, { steps: 8 });

    await player.post({ type: 'zoom', action: 'reset' });
    await player.waitForEvent({ type: 'zoomChanged', level: 1 });
    await page.mouse.move(100, 100, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    expectArea(await shownArea(page), { left: 0, top: 0, width: 1, height: 1 });
    expect((await player.video()).paused).toBe(true);
    await expect(page.locator('body')).not.toHaveClass(/panning/);
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
