import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, spots, type PlayerHarness } from './player-page.js';

const lessonId = 'Section 1/01 Welcome.webm';

function load(startAt: number, autoplay = false): PlayerCommand {
  return {
    type: 'load',
    lessonId,
    videoUri: media.long,
    container: 'webm',
    startAt,
    autoplay,
  };
}

/** A Lesson paused at `startAt`, whose length is known, with the Rewind the player was told. */
async function pausedAt(
  player: PlayerHarness,
  startAt: number,
  rewind: number | undefined,
): Promise<void> {
  if (rewind !== undefined) {
    await player.post({ type: 'setResumeRewind', seconds: rewind });
  }
  await player.post(load(startAt));
  await expect.poll(async () => (await player.video()).currentTime).toBeCloseTo(startAt, 0);
  await expect.poll(async () => (await player.video()).duration).toBeGreaterThan(startAt);
}

test.describe('a click that resumes a paused Lesson', () => {
  test('steps back by the Rewind, then plays', async ({ page }) => {
    const player = await openPlayer(page);
    await pausedAt(player, 2, 1.5);
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);

    await player.waitForEvent({ type: 'played', lessonId });
    // Played on from 0.5 s: back of where it stopped, and not yet past it.
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(0.45);
    expect((await player.video()).currentTime).toBeLessThan(1.9);
  });

  test('stops at the start of the Lesson', async ({ page }) => {
    const player = await openPlayer(page);
    await pausedAt(player, 1, 30);
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);

    await player.waitForEvent({ type: 'played', lessonId });
    expect((await player.video()).currentTime).toBeLessThan(0.9);
  });

  test('does not seek when the Rewind is 0', async ({ page }) => {
    const player = await openPlayer(page);
    await pausedAt(player, 2, undefined);
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);

    await player.waitForEvent({ type: 'played', lessonId });
    expect((await player.video()).currentTime).toBeGreaterThanOrEqual(1.99);
    expect((await player.events()).filter((event) => event.type === 'seeked')).toHaveLength(1);
  });

  test('does not step back when the click pauses a playing Lesson', async ({ page }) => {
    const player = await openPlayer(page);
    await player.post({ type: 'setResumeRewind', seconds: 1.5 });
    await player.post(load(0, true));
    await player.waitForEvent({ type: 'played', lessonId });
    await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(0.6);
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);
    await player.waitForEvent({ type: 'paused', lessonId, byUser: true });
    const stoppedAt = (await player.video()).currentTime;

    expect(stoppedAt).toBeGreaterThan(0.6);
    expect((await player.events()).filter((event) => event.type === 'seeked')).toHaveLength(0);
  });

  test('reports one interaction, as a click without a Rewind does', async ({ page }) => {
    const player = await openPlayer(page);
    await pausedAt(player, 2, 1.5);
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);
    await player.waitForEvent({ type: 'played', lessonId });
    await page.waitForTimeout(300);

    const reported = (await player.events()).filter((event) => event.type === 'userInteracted');
    expect(reported).toHaveLength(1);
  });

  test('does not seek when the Lesson is at its start', async ({ page }) => {
    const player = await openPlayer(page);
    await pausedAt(player, 0, 3);
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);

    await player.waitForEvent({ type: 'played', lessonId });
    expect((await player.events()).filter((event) => event.type === 'seeked')).toHaveLength(0);
  });

  test('starts a Lesson that ended again from the top, with no step back first', async ({
    page,
  }) => {
    const player = await openPlayer(page);
    await player.post({ type: 'setResumeRewind', seconds: 1.5 });
    await player.post({
      type: 'load',
      lessonId,
      videoUri: media.webm,
      container: 'webm',
      startAt: 2.5,
      autoplay: true,
    });
    await player.waitForEvent({ type: 'ended', lessonId });
    const { picture } = await spots(page);

    await page.mouse.click(picture.x, picture.y);

    await expect.poll(async () => (await player.video()).ended).toBe(false);
    await player.waitForEvent({ type: 'played', lessonId });
    // From the top, not from 1.5 s (the end, 3 s, less the Rewind).
    expect((await player.video()).currentTime).toBeLessThan(1);
  });
});
