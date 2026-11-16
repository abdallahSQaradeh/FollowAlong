/**
 * Seam 2 harness: loads the real player page (renderPlayerHtml with the built out/player bundle)
 * in Chromium at a fake webview origin, stands in for VS Code's `acquireVsCodeApi`, serves the
 * media fixtures, and lets a test post protocol commands and read the events the player sent.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { renderPlayerHtml } from '../../src/player/page.js';
import type { PlayerTuning } from '../../src/player/tuning.js';
import type { PlayerCommand, PlayerEvent } from '../../src/protocol/player-messages.js';
import { expect } from './fixtures.js';

const root = resolve(__dirname, '..', '..');
/** Stands in for the webview's resource origin (`webview.cspSource`). */
export const origin = 'https://webview.followalong.test';
export const media = {
  /** 3 s, VP8 + Vorbis (scripts/make-media-fixtures.mjs). */
  webm: `${origin}/media/lesson.webm`,
  /** 3 s, H.264 + AAC, index at the start (scripts/make-media-fixtures.mjs). */
  mp4: `${origin}/media/sample.mp4`,
  /** 8 s, VP8 + Vorbis, a Cluster every second. */
  long: `${origin}/media/long.webm`,
  /** The same 8 s without a Duration element, as an unfinalised recording has. */
  noDuration: `${origin}/media/no-duration.webm`,
  /** A text file with a .webm name, as a broken download would be. */
  notAVideo: `${origin}/media/not-a-video.webm`,
  /** A download that stopped before its first byte. */
  empty: `${origin}/media/empty.webm`,
} as const;
export const webmDuration = 3;
export const mp4Duration = 3;

declare global {
  interface Window {
    /** Every message the player posted to the extension, in order. */
    followalongSent?: unknown[];
  }
}

export interface PlayerOptions {
  /** Forces the AAC capability the page reports (stock Chromium's own answer otherwise). */
  readonly aac?: boolean;
  /** Test-only player knobs (src/player/tuning.ts). */
  readonly tuning?: PlayerTuning;
  /** Answer Range requests with bytes that are not WebM, as a file changed on disk would. */
  readonly brokenRanges?: boolean;
}

export interface PlayerHarness {
  post(command: PlayerCommand): Promise<void>;
  /** Posts several commands in one go, so the page receives them back to back. */
  postAll(commands: readonly PlayerCommand[]): Promise<void>;
  events(): Promise<PlayerEvent[]>;
  /** Waits until the player has sent an event matching `expected` (a partial event). */
  waitForEvent(expected: Partial<PlayerEvent>): Promise<void>;
  video(): Promise<VideoState>;
}

export interface VideoState {
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly ended: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly currentSrc: string;
  readonly audioBytesDecoded: number;
  readonly videoBytesDecoded: number;
  /** The buffered time ranges, as [start, end] pairs in seconds. */
  readonly buffered: readonly (readonly [number, number])[];
}

export async function openPlayer(page: Page, options: PlayerOptions = {}): Promise<PlayerHarness> {
  const html = renderPlayerHtml({
    cspSource: origin,
    nonce: 'c2VhbTItbm9uY2U',
    script: readFileSync(join(root, 'out', 'player', 'player.js'), 'utf8'),
    style: readFileSync(join(root, 'out', 'player', 'player.css'), 'utf8'),
  });
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: html });
    } else if (
      path === '/media/lesson.webm' ||
      path === '/media/long.webm' ||
      path === '/media/no-duration.webm' ||
      path === '/media/sample.mp4'
    ) {
      const contentType = path.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
      const body = readFileSync(join(root, 'test', 'fixtures', path));
      // Byte ranges, as VS Code's webview resource loader answers them (research 01: 206).
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
      if (range === null) {
        await route.fulfill({ contentType, body });
        return;
      }
      if (options.brokenRanges === true) {
        await route.fulfill({ status: 206, contentType, body: 'changed on disk' });
        return;
      }
      const start = Number(range[1]);
      const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
      await route.fulfill({
        status: 206,
        contentType,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${String(start)}-${String(end)}/${String(body.length)}`,
        },
        body: body.subarray(start, end + 1),
      });
    } else if (path === '/media/empty.webm') {
      await route.fulfill({ contentType: 'video/webm', body: '' });
    } else if (path === '/media/not-a-video.webm') {
      await route.fulfill({ contentType: 'video/webm', body: 'this download was cut short' });
    } else {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
  await page.addInitScript(
    ({ aac, tuning }: { aac: boolean | undefined; tuning: PlayerTuning | undefined }) => {
      if (tuning !== undefined) {
        window.followalongPlayerTuning = tuning;
      }
      const sent: unknown[] = [];
      window.followalongSent = sent;
      Object.defineProperty(window, 'acquireVsCodeApi', {
        value: () => ({ postMessage: (message: unknown) => sent.push(message) }),
      });
      if (aac !== undefined) {
        const original = HTMLMediaElement.prototype.canPlayType.bind(
          document.createElement('video'),
        );
        HTMLMediaElement.prototype.canPlayType = (type: string) =>
          type.includes('mp4a') ? (aac ? 'probably' : '') : original(type);
      }
    },
    { aac: options.aac, tuning: options.tuning },
  );
  await page.goto(`${origin}/`);

  const events = () => page.evaluate(() => (window.followalongSent ?? []) as PlayerEvent[]);
  return {
    async post(command) {
      await page.evaluate((message) => {
        window.postMessage(message, '*');
      }, command);
    },
    async postAll(commands) {
      await page.evaluate((messages) => {
        for (const message of messages) {
          window.postMessage(message, '*');
        }
      }, commands);
    },
    events,
    async waitForEvent(expected) {
      await expect
        .poll(async () => (await events()).some((event) => matches(event, expected)), {
          message: `the player sends ${JSON.stringify(expected)}`,
          timeout: 10_000,
        })
        .toBe(true);
    },
    video: () =>
      page.locator('video').evaluate((element: HTMLVideoElement): VideoState => {
        const decoded = element as HTMLVideoElement & {
          webkitAudioDecodedByteCount: number;
          webkitVideoDecodedByteCount: number;
        };
        return {
          paused: element.paused,
          muted: element.muted,
          volume: element.volume,
          ended: element.ended,
          currentTime: element.currentTime,
          duration: element.duration,
          currentSrc: element.currentSrc,
          audioBytesDecoded: decoded.webkitAudioDecodedByteCount,
          videoBytesDecoded: decoded.webkitVideoDecodedByteCount,
          buffered: Array.from(
            { length: element.buffered.length },
            (_, index) => [element.buffered.start(index), element.buffered.end(index)] as const,
          ),
        };
      }),
  };
}

function matches(event: PlayerEvent, expected: Partial<PlayerEvent>): boolean {
  return Object.entries(expected).every(
    ([key, value]) => (event as unknown as Record<string, unknown>)[key] === value,
  );
}
