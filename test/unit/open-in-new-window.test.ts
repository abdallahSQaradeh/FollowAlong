import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const buttonLabel = 'Open in new window';

/** A Courses root with two Courses, Alpha and Beta; Alpha is open in this window. */
async function windowWithAlphaOpen(h: Harness): Promise<{ alpha: string; beta: string }> {
  const learning = await h.folder('Learning', {
    'Alpha/intro.mp4': 'v',
    'Beta/intro.mp4': 'v',
  });
  h.config.set('coursesRoots', [learning]);
  const alpha = join(learning, 'Alpha');
  await h.core.openCourse(alpha);
  h.player.ready();
  return { alpha, beta: join(learning, 'Beta') };
}

/** The video the player was told to load, if any. */
function loadedVideo(h: Harness): string | undefined {
  for (const message of h.player.sent) {
    if (message.type === 'load') {
      return message.videoUri;
    }
  }
  return undefined;
}

/** The learner presses Open in new window beside Beta in the Course picker. */
async function openBetaInNewWindow(h: Harness): Promise<void> {
  const picking = h.core.pickCourse();
  await h.ui.pickerShown();
  h.ui.press('Beta', buttonLabel);
  await picking;
}

describe('opening a Course in a new window', () => {
  it('offers the button on every Course that is not missing, in Recent and in the list', async () => {
    const h = await createHarness();
    await windowWithAlphaOpen(h);

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(h.ui.buttonsOf('Alpha')).toContain(buttonLabel);
    expect(h.ui.buttonsOf('Beta')).toContain(buttonLabel);
  });

  it('offers no button on a missing Recent Course, which has Locate… and Remove', async () => {
    const h = await createHarness();
    const { beta } = await windowWithAlphaOpen(h);
    await h.core.openCourse(beta);
    await rm(beta, { recursive: true });

    void h.core.pickCourse();
    await h.ui.pickerShown();

    expect(h.ui.buttonsOf('Beta')).toEqual(['Locate…', 'Remove']);
  });

  it('opens a new window and leaves this window’s Course as it is', async () => {
    const h = await createHarness();
    await windowWithAlphaOpen(h);
    h.player.clearSent();

    await openBetaInNewWindow(h);

    expect(h.ui.newWindows).toBe(1);
    expect(h.player.sent.filter((message) => message.type === 'load')).toEqual([]);
    expect(h.ui.picker).toBeUndefined();
  });

  it('opens the chosen Course in the new window, which remembers it as its own', async () => {
    const h = await createHarness();
    const { beta } = await windowWithAlphaOpen(h);
    await openBetaInNewWindow(h);

    h.restart({ otherWorkspace: true });
    await h.core.restoreCourse();
    h.player.ready();

    expect(loadedVideo(h)).toBe(h.player.resourceUri(join(beta, 'intro.mp4')));
    await h.core.close();

    h.restart();
    await h.core.restoreCourse();
    h.player.ready();
    expect(loadedVideo(h)).toBe(h.player.resourceUri(join(beta, 'intro.mp4')));
  });

  it('is used once: the next new window opens no Course', async () => {
    const h = await createHarness();
    await windowWithAlphaOpen(h);
    await openBetaInNewWindow(h);
    h.restart({ otherWorkspace: true });
    await h.core.restoreCourse();

    h.restart({ otherWorkspace: true });
    await h.core.restoreCourse();

    expect(h.player.shown).toEqual([]);
  });

  it('is forgotten after 30 seconds, so a stray note never opens a Course later', async () => {
    const h = await createHarness();
    await windowWithAlphaOpen(h);
    await openBetaInNewWindow(h);
    h.clock.advance(31_000);

    h.restart({ otherWorkspace: true });
    await h.core.restoreCourse();

    expect(h.player.shown).toEqual([]);
  });

  it('opens the requested Course even where the window remembers another one', async () => {
    const h = await createHarness();
    const { beta } = await windowWithAlphaOpen(h);
    await openBetaInNewWindow(h);

    h.restart();
    await h.core.restoreCourse();

    h.player.ready();
    expect(loadedVideo(h)).toBe(h.player.resourceUri(join(beta, 'intro.mp4')));
  });

  it('opens no Course when the new window could not be opened', async () => {
    const h = await createHarness();
    await windowWithAlphaOpen(h);
    h.ui.failNewWindow = true;

    await openBetaInNewWindow(h);
    h.restart({ otherWorkspace: true });
    await h.core.restoreCourse();

    expect(h.player.shown).toEqual([]);
    expect(h.ui.messages).toEqual([
      { severity: 'error', text: 'FollowAlong could not open “Beta” in a new window.' },
    ]);
  });
});
