import { expect, test } from './fixtures.js';
import { media, openPlayer, spots } from './player-page.js';

const lessonId = 'Section 1/01 Welcome.webm';

test('a click on the picture starts the Lesson that could not start by itself', async ({
  page,
}) => {
  // VS Code posts to the player without a user gesture, so Chromium refuses the Lesson's
  // autoplay until the learner acts in the page (#12 D3).
  const player = await openPlayer(page, { userGestures: false });
  await player.post({
    type: 'load',
    lessonId,
    videoUri: media.long,
    container: 'webm',
    startAt: 0,
    autoplay: true,
  });
  await player.waitForEvent({ type: 'paused', lessonId, byUser: false });
  expect((await player.events()).map((event) => event.type)).not.toContain('played');
  const { picture } = await spots(page);

  await page.mouse.click(picture.x, picture.y);

  await player.waitForEvent({ type: 'played', lessonId });
  await expect.poll(async () => (await player.video()).currentTime).toBeGreaterThan(0.3);
  expect((await player.video()).muted).toBe(false);
});
