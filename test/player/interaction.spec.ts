import type { Page } from '@playwright/test';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { controlBarShown, media, openPlayer, spots, type PlayerHarness } from './player-page.js';

const lessonId = 'Section 1/01 Welcome.webm';

function load(overrides: Partial<Extract<PlayerCommand, { type: 'load' }>> = {}): PlayerCommand {
  return {
    type: 'load',
    lessonId,
    videoUri: media.long,
    container: 'webm',
    startAt: 0,
    autoplay: true,
    ...overrides,
  };
}

/** Moves the mouse over the video first, so the native control bar shows. */
async function revealControls(page: Page): Promise<void> {
  const { picture } = await spots(page);
  await page.mouse.move(picture.x, picture.y);
  await page.mouse.move(picture.x + 10, picture.y + 10);
}

/** Loads the Lesson without autoplay, and waits until its length is known. */
async function loadPaused(player: PlayerHarness): Promise<void> {
  await player.post(load({ autoplay: false }));
  await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
}

async function interactions(player: PlayerHarness): Promise<number> {
  return (await player.events()).filter((event) => event.type === 'userInteracted').length;
}

test.describe('a click on the picture', () => {
  test('pauses a playing Lesson, as the learner’s pause, and hands focus back', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);

    await player.waitForEvent({ type: 'paused', lessonId, byUser: true });
    await player.waitForEvent({ type: 'userInteracted' });
    expect((await player.video()).paused).toBe(true);
  });

  test('plays a paused Lesson at once, and hands focus back', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);

    // At once: not after the native player's wait for a possible double-click.
    expect((await player.video()).paused).toBe(false);
    await player.waitForEvent({ type: 'played', lessonId });
    await player.waitForEvent({ type: 'userInteracted' });
  });

  test('hands focus back once per click', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);
    await player.waitForEvent({ type: 'paused', lessonId, byUser: true });
    await page.mouse.click(picture.x, picture.y);
    await expect
      .poll(async () => (await player.events()).filter((event) => event.type === 'played'))
      .toHaveLength(2);
    await page.waitForTimeout(300);

    expect(await interactions(player)).toBe(2);
  });
});

test.describe('the native control bar', () => {
  test('hands focus back after its play button is clicked', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    await revealControls(page);
    const { playButton } = await spots(page);

    await page.mouse.click(playButton.x, playButton.y);

    await player.waitForEvent({ type: 'played', lessonId });
    await player.waitForEvent({ type: 'userInteracted' });
  });

  test('hands focus back after its mute button is clicked', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    await revealControls(page);
    const { muteButton } = await spots(page);

    await page.mouse.click(muteButton.x, muteButton.y);

    expect((await player.video()).muted).toBe(true);
    await player.waitForEvent({ type: 'userInteracted' });
  });

  test('keeps focus while the seek bar is dragged, and hands it back on release', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    await revealControls(page);
    const { timeline } = await spots(page);

    await page.mouse.move(timeline(0.1).x, timeline(0.1).y);
    await page.mouse.down();
    await page.mouse.move(timeline(0.4).x, timeline(0.4).y, { steps: 5 });
    await page.mouse.move(timeline(0.6).x, timeline(0.6).y, { steps: 5 });
    // The drag really moves the playhead, and nothing asks for focus yet.
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(3);
    await page.waitForTimeout(300);
    expect(await interactions(player)).toBe(0);

    await page.mouse.up();

    await player.waitForEvent({ type: 'userInteracted' });
  });
});

// Gate round 1 of #23: below the overlay, Chromium's control panel keeps every pointer event, so
// a click there must still be reported, at any panel shape.
for (const viewport of [
  { width: 1280, height: 720, shape: '16:9' },
  { width: 1280, height: 500, shape: 'wider than the video' },
  { width: 480, height: 480, shape: 'narrower than the video' },
]) {
  test.describe(`the strip along the bottom, ${viewport.shape}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const playing of [false, true]) {
      test(`hands focus back after a click at any height there, ${playing ? 'playing' : 'paused'}`, async ({
        page,
      }) => {
        const player = await openPlayer(page);
        if (playing) {
          await player.post(load());
          await player.waitForEvent({ type: 'played', lessonId });
        } else {
          await loadPaused(player);
        }
        const box = await page.locator('video').boundingBox();
        if (box === null) {
          throw new Error('the video is not on screen');
        }

        for (const [index, above] of [70, 62, 56, 48, 35].entries()) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height - above);
          await expect
            .poll(() => interactions(player), {
              message: `a click ${String(above)} px above the bottom`,
            })
            .toBe(index + 1);
        }
      });
    }
  });
}

test.describe('hovering the picture', () => {
  test.use({ viewport: { width: 480, height: 270 } });

  test('shows the native control bar again after it hid', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });
    const { picture } = await spots(page);
    await page.mouse.move(picture.x, picture.y);
    // Chromium hides the bar after about 3 s without a pointer move while the Lesson plays.
    await expect.poll(() => controlBarShown(page), { timeout: 8_000 }).toBe(false);

    await page.mouse.move(picture.x + 20, picture.y + 10, { steps: 3 });

    await expect.poll(() => controlBarShown(page)).toBe(true);
  });
});

test.describe('a seek-bar drag while the Lesson plays', () => {
  test('keeps focus until the learner lets go, then hands it back', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });
    await revealControls(page);
    const { timeline } = await spots(page);

    // Chromium pauses while the seek bar is scrubbed, and plays on when it is let go.
    await page.mouse.move(timeline(0.1).x, timeline(0.1).y);
    await page.mouse.down();
    await page.mouse.move(timeline(0.5).x, timeline(0.5).y, { steps: 5 });
    await page.waitForTimeout(300);
    expect(await interactions(player)).toBe(0);

    await page.mouse.up();

    await player.waitForEvent({ type: 'userInteracted' });
    await expect.poll(async () => (await player.video()).paused).toBe(false);
    // One release, one report, although Chromium also plays on by itself.
    await page.waitForTimeout(500);
    expect(await interactions(player)).toBe(1);
  });
});

test.describe('two pointers dragging at once (touch and mouse)', () => {
  test('keeps focus until both have let go', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);
    const capture = (type: string, pointerId: number) =>
      page.locator('video').evaluate(
        (video, init) => {
          video.dispatchEvent(new PointerEvent(init.type, { pointerId: init.pointerId }));
        },
        { type, pointerId },
      );

    await capture('gotpointercapture', 1);
    await capture('gotpointercapture', 2);
    await capture('lostpointercapture', 1);
    await page.waitForTimeout(300);
    expect(await interactions(player)).toBe(0);

    await capture('lostpointercapture', 2);

    await player.waitForEvent({ type: 'userInteracted' });
  });
});

test.describe('the keyboard in the player', () => {
  test('hands focus back once a key is released', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    // Tab to the native controls, as the learner might after a click in the player.
    await page.keyboard.down('Tab');
    await page.waitForTimeout(100);
    expect(await interactions(player)).toBe(0);
    await page.keyboard.up('Tab');

    await player.waitForEvent({ type: 'userInteracted' });
  });
});

// Gate round 2 of #23: a press held on a native control reports once, on release, never mid-press.
test.describe('a held press', () => {
  for (const holdMs of [0, 400, 800]) {
    test(`on the play button, held ${String(holdMs)} ms, hands focus back once, on release`, async ({
      page,
    }) => {
      const player = await openPlayer(page);
      await loadPaused(player);
      await revealControls(page);
      const { playButton } = await spots(page);

      await page.mouse.move(playButton.x, playButton.y);
      await page.mouse.down();
      await page.waitForTimeout(holdMs);
      expect(await interactions(player)).toBe(0);
      await page.mouse.up();

      await player.waitForEvent({ type: 'played', lessonId });
      await page.waitForTimeout(500);
      expect(await interactions(player)).toBe(1);
    });
  }

  test('of Tab, held 600 ms, hands focus back once, on release', async ({ page }) => {
    const player = await openPlayer(page);
    await loadPaused(player);

    await page.keyboard.down('Tab');
    await page.waitForTimeout(600);
    expect(await interactions(player)).toBe(0);
    await page.keyboard.up('Tab');

    await player.waitForEvent({ type: 'userInteracted' });
    await page.waitForTimeout(500);
    expect(await interactions(player)).toBe(1);
  });
});

test.describe('fullscreen', () => {
  test('keeps focus in the player while fullscreen, and hands it back once it ends', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });
    // The native fullscreen button makes the video element fullscreen, as this does.
    await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
      await video.requestFullscreen();
    });

    // Space toggles the native player; the learner is watching, not typing into hidden code.
    await page.keyboard.press('Space');
    await page.mouse.click(400, 300);
    await page.waitForTimeout(600);
    expect(await interactions(player)).toBe(0);

    await page.evaluate(async () => {
      await document.exitFullscreen();
    });

    await player.waitForEvent({ type: 'userInteracted' });
    await page.waitForTimeout(500);
    expect(await interactions(player)).toBe(1);
  });
});

test.describe('commands from the extension', () => {
  test('seek steps, back, forward and past the end, without asking for focus', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });

    await player.post({ type: 'seekBy', seconds: 2 });
    await player.waitForEvent({ type: 'seeked', lessonId });
    await player.post({ type: 'seekBy', seconds: -1.5 });
    await expect
      .poll(async () => (await player.events()).filter((event) => event.type === 'seeked'))
      .toHaveLength(2);
    await player.post({ type: 'seekBy', seconds: 30 });
    await player.waitForEvent({ type: 'ended', lessonId });
    await page.waitForTimeout(300);

    expect(await interactions(player)).toBe(0);
  });

  test('play and pause without asking for focus', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load());
    await player.waitForEvent({ type: 'played', lessonId });

    await player.post({ type: 'pause' });
    await player.waitForEvent({ type: 'paused', lessonId, byUser: false });
    await player.post({ type: 'play' });
    await expect
      .poll(async () => (await player.events()).filter((event) => event.type === 'played'))
      .toHaveLength(2);
    await page.waitForTimeout(300);

    expect(await interactions(player)).toBe(0);
  });
});
