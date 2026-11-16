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

/** The byte offset of each Cluster of the 8 s fixture, found by the Cluster element ID. */
const longClusters: readonly number[] = (() => {
  const file = readFileSync(join(root, 'test', 'fixtures', 'media', 'long.webm'));
  const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  const offsets: number[] = [];
  for (let at = file.indexOf(clusterId); at !== -1; at = file.indexOf(clusterId, at + 1)) {
    offsets.push(at);
  }
  return offsets;
})();

/**
 * The byte offset of Cluster `index` of the 8 s fixture, for `holdAt`. There is one a second:
 * Cluster 3 starts at 0:02.988 (with sound), just before the keyframe at 0:03.003.
 */
export function longClusterOffset(index: number): number {
  const offset = longClusters[index];
  if (offset === undefined) {
    throw new Error(`long.webm has no Cluster ${String(index)}`);
  }
  return offset;
}
export const mp4Duration = 3;

declare global {
  interface Window {
    /** Every message the player posted to the extension, in order. */
    followalongSent?: unknown[];
    /** Set with `holdAt`: lets the held streams go on. */
    followalongReleaseStream?: () => void;
    /** Set with `holdAt`: resolves once a held stream has passed on bytes after `holdAt`. */
    followalongStreamDelivered?: Promise<void>;
  }
}

export interface PlayerOptions {
  /** Forces the AAC capability the page reports (stock Chromium's own answer otherwise). */
  readonly aac?: boolean;
  /** Test-only player knobs (src/player/tuning.ts). */
  readonly tuning?: PlayerTuning;
  /** Answer Range requests with bytes that are not WebM, as a file changed on disk would. */
  readonly brokenRanges?: boolean;
  /**
   * Hold every media stream at this file offset until `releaseStream()`: the bytes before it
   * arrive as one chunk, the rest only once released. Playwright delivers a whole response body
   * at once, so this is how a test fixes what is buffered when something else happens.
   */
  readonly holdAt?: number;
}

export interface PlayerHarness {
  post(command: PlayerCommand): Promise<void>;
  /** Posts several commands in one go, so the page receives them back to back. */
  postAll(commands: readonly PlayerCommand[]): Promise<void>;
  events(): Promise<PlayerEvent[]>;
  /** Waits until the player has sent an event matching `expected` (a partial event). */
  waitForEvent(expected: Partial<PlayerEvent>): Promise<void>;
  video(): Promise<VideoState>;
  /** Lets streams held by `holdAt` go on; returns once the player has read the bytes after it. */
  releaseStream(): Promise<void>;
  /** The Range header of every media request the player made, in order. */
  rangeRequests(): readonly string[];
}

export interface VideoState {
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly ended: boolean;
  readonly currentTime: number;
  readonly playbackRate: number;
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
  const rangeRequests: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const requestedRange = route.request().headers().range;
    if (path.startsWith('/media/') && requestedRange !== undefined) {
      rangeRequests.push(requestedRange);
    }
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
      const range = /^bytes=(\d+)-(\d*)$/.exec(requestedRange ?? '');
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
    ({
      aac,
      tuning,
      holdAt,
    }: {
      aac: boolean | undefined;
      tuning: PlayerTuning | undefined;
      holdAt: number | undefined;
    }) => {
      if (tuning !== undefined) {
        window.followalongPlayerTuning = tuning;
      }
      if (holdAt !== undefined) {
        // The player streams with fetch: pass each body on only up to `holdAt` until released.
        const released = new Promise<void>((resolve) => {
          window.followalongReleaseStream = resolve;
        });
        let delivered = () => {
          // Replaced right below.
        };
        window.followalongStreamDelivered = new Promise<void>((resolve) => {
          delivered = resolve;
        });
        const fetchFile = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const response = await fetchFile(input, init);
          if (response.body === null) {
            return response;
          }
          const reader = response.body.getReader();
          const from = /^bytes (\d+)-/.exec(response.headers.get('Content-Range') ?? '');
          let offset = from === null ? 0 : Number(from[1]);
          const before: Uint8Array[] = [];
          const held = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await reader.read();
              if (done) {
                for (const chunk of before.splice(0)) {
                  controller.enqueue(chunk);
                }
                controller.close();
                return;
              }
              const cut = Math.min(Math.max(holdAt - offset, 0), value.length);
              offset += value.length;
              if (cut > 0) {
                before.push(value.subarray(0, cut));
              }
              if (offset < holdAt) {
                return;
              }
              // Everything before `holdAt` as one chunk, then the rest once released.
              const total = before.reduce((length, chunk) => length + chunk.length, 0);
              if (total > 0) {
                const joined = new Uint8Array(total);
                let at = 0;
                for (const chunk of before.splice(0)) {
                  joined.set(chunk, at);
                  at += chunk.length;
                }
                controller.enqueue(joined);
              }
              await released;
              if (cut < value.length) {
                controller.enqueue(value.subarray(cut));
                delivered();
              }
            },
            cancel: (reason) => reader.cancel(reason),
          });
          return new Response(held, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        };
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
    { aac: options.aac, tuning: options.tuning, holdAt: options.holdAt },
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
    async releaseStream() {
      await page.evaluate(async () => {
        window.followalongReleaseStream?.();
        await window.followalongStreamDelivered;
        // A task later, the player has read those bytes and acted on them.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    rangeRequests: () => [...rangeRequests],
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
          playbackRate: element.playbackRate,
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
