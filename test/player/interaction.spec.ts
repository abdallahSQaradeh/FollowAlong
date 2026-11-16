import type { Page } from '@playwright/test';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, spots, type PlayerHarness } from './player-page.js';

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
    await player.post(load({ autoplay: false }));
    await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
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
    await player.post(load({ autoplay: false }));
    await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
    await revealControls(page);
    const { playButton } = await spots(page);

    await page.mouse.click(playButton.x, playButton.y);

    await player.waitForEvent({ type: 'played', lessonId });
    await player.waitForEvent({ type: 'userInteracted' });
  });

  test('hands focus back after its mute button is clicked', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load({ autoplay: false }));
    await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
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
    await player.post(load({ autoplay: false }));
    await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);
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

test.describe('the keyboard in the player', () => {
  test('hands focus back once a key is released', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post(load({ autoplay: false }));
    await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(0);

    // Tab to the native controls, as the learner might after a click in the player.
    await page.keyboard.down('Tab');
    await page.waitForTimeout(100);
    expect(await interactions(player)).toBe(0);
    await page.keyboard.up('Tab');

    await player.waitForEvent({ type: 'userInteracted' });
  });
});

test.describe('commands from the extension', () => {
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
