import type { Page } from '@playwright/test';

import type { PlayerCommand } from '../../src/protocol/player-messages.js';
import { expect, test } from './fixtures.js';
import { media, openPlayer, type PlayerHarness } from './player-page.js';

const lessonId = 'Section 1/02 Setup.mp4';

/** A `load` of the MP4 fixture, 0.4 s from its end, so the Lesson ends at once. */
function loadNearTheEnd(): PlayerCommand {
  return {
    type: 'load',
    lessonId,
    videoUri: media.mp4,
    container: 'mp4',
    startAt: 2.6,
    autoplay: true,
  };
}

/** The player with a Lesson that has played to its end. */
async function endedLesson(page: Page): Promise<PlayerHarness> {
  const player = await openPlayer(page);
  await player.post(loadNearTheEnd());
  await player.waitForEvent({ type: 'ended', lessonId });
  return player;
}

function nextOverlay(page: Page) {
  return page.getByRole('button', { name: /^Next: / });
}

test.describe('the Next overlay', () => {
  test('is not there until the extension shows it', async ({ page }) => {
    await endedLesson(page);

    await expect(nextOverlay(page)).toBeHidden();
  });

  test('shows “Next: <title>” over the stopped picture when the extension asks', async ({
    page,
  }) => {
    const player = await endedLesson(page);

    await player.post({ type: 'showNext', title: 'Tools of the trade' });

    await expect(page.getByRole('button', { name: 'Next: Tools of the trade' })).toBeVisible();
    expect((await player.video()).ended).toBe(true);
  });

  test('shows the title as text, never as markup', async ({ page }) => {
    const player = await endedLesson(page);

    await player.post({ type: 'showNext', title: '<b>Bold</b> & <i>more</i>' });

    await expect(
      page.getByRole('button', { name: 'Next: <b>Bold</b> & <i>more</i>' }),
    ).toBeVisible();
  });

  test('a click on it posts nextClicked for the Lesson that ended, and plays nothing', async ({
    page,
  }) => {
    const player = await endedLesson(page);
    await player.post({ type: 'showNext', title: 'Welcome' });

    const eventsBefore = (await player.events()).length;

    await nextOverlay(page).click();

    await player.waitForEvent({ type: 'nextClicked', lessonId });
    expect((await player.events()).slice(eventsBefore)).toEqual([
      { type: 'nextClicked', lessonId },
    ]);
    expect((await player.video()).ended).toBe(true);
  });

  test('goes away when the next Lesson loads', async ({ page }) => {
    const player = await endedLesson(page);
    await player.post({ type: 'showNext', title: 'Welcome' });
    await expect(nextOverlay(page)).toBeVisible();

    await player.post({
      type: 'load',
      lessonId: 'Section 2/03 Tools.mp4',
      videoUri: media.mp4,
      container: 'mp4',
      startAt: 0,
      autoplay: false,
    });

    await expect(nextOverlay(page)).toBeHidden();
  });

  test('goes away when the learner plays the Lesson again', async ({ page }) => {
    const player = await endedLesson(page);
    await player.post({ type: 'showNext', title: 'Welcome' });
    await expect(nextOverlay(page)).toBeVisible();

    await player.post({ type: 'play' });

    await expect(nextOverlay(page)).toBeHidden();
  });

  test('goes away when the learner steps back into the Lesson', async ({ page }) => {
    const player = await endedLesson(page);
    await player.post({ type: 'showNext', title: 'Welcome' });
    await expect(nextOverlay(page)).toBeVisible();

    await player.post({ type: 'seekBy', seconds: -2 });

    await expect(nextOverlay(page)).toBeHidden();
  });

  test('is not shown over a Lesson that plays again before the extension answers', async ({
    page,
  }) => {
    const player = await endedLesson(page);
    await player.post({ type: 'play' });
    await player.waitForEvent({ type: 'played', lessonId });

    await player.post({ type: 'showNext', title: 'Welcome' });

    await expect(nextOverlay(page)).toBeHidden();
  });

  test('comes back, with the new title, when the Lesson ends again', async ({ page }) => {
    const player = await endedLesson(page);
    await player.post({ type: 'showNext', title: 'Welcome' });
    await player.post({ type: 'seekBy', seconds: -2 });
    await expect(nextOverlay(page)).toBeHidden();
    await player.post({ type: 'play' });
    await expect
      .poll(async () => (await player.events()).filter((e) => e.type === 'ended').length)
      .toBe(2);

    await player.post({ type: 'showNext', title: 'Setup' });

    await expect(page.getByRole('button', { name: 'Next: Setup' })).toBeVisible();
  });
});
