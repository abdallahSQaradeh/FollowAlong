/**
 * Seam 2 harness: loads the real player page (renderPlayerHtml with the built out/player bundle)
 * in Chromium at a fake webview origin, stands in for VS Code's `acquireVsCodeApi`, serves the
 * media fixtures, and lets a test post protocol commands and read the events the player sent.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Page, PageScreenshotOptions } from '@playwright/test';

import { renderPlayerHtml } from '../../src/player/page.js';
import type { PlayerTuning } from '../../src/player/tuning.js';
import {
  pageSoundCodecs,
  type PlayerCommand,
  type PlayerEvent,
} from '../../src/protocol/player-messages.js';
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
  /** 8 s, H.264 + AAC, index (moov atom) at the end. */
  sidecarMp4: `${origin}/media/sidecar.mp4`,
  /** sidecar.mp4's sound as the audio sidecar converts it (MP3). */
  sidecarMp3: `${origin}/media/sidecar.mp3`,
} as const;
export const webmDuration = 3;

/** The byte offset of each Cluster of a fixture, found by the Cluster element ID. */
function clusterOffsets(name: string): readonly number[] {
  const file = readFileSync(join(root, 'test', 'fixtures', 'media', name));
  const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  const offsets: number[] = [];
  for (let at = file.indexOf(clusterId); at !== -1; at = file.indexOf(clusterId, at + 1)) {
    offsets.push(at);
  }
  return offsets;
}

function clusterOffset(name: string, offsets: readonly number[], index: number): number {
  const offset = offsets[index];
  if (offset === undefined) {
    throw new Error(`${name} has no Cluster ${String(index)}`);
  }
  return offset;
}

const longClusters = clusterOffsets('long.webm');
const noDurationClusters = clusterOffsets('no-duration.webm');

/**
 * The byte offset of Cluster `index` of the 8 s fixture, for `holdAt`. There is one a second:
 * Cluster 3 starts at 0:02.988 (with sound), just before the keyframe at 0:03.003.
 */
export function longClusterOffset(index: number): number {
  return clusterOffset('long.webm', longClusters, index);
}

/** The same for the 8 s fixture without a Duration element (Cluster 0 starts right after its init segment). */
export function noDurationClusterOffset(index: number): number {
  return clusterOffset('no-duration.webm', noDurationClusters, index);
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
  /**
   * Forces which of the other sound codecs the page decodes in an MP4 (`mp3`, `opus`, `flac`);
   * stock Chromium's own answer otherwise.
   */
  readonly soundCodecs?: readonly string[];
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
  /**
   * Hold back the first `updateend` of each source buffer until the media element has fired
   * `loadedmetadata`. Chromium fires `loadedmetadata` before the end of a large first append about
   * half the time (#25, H1), and after a small one; this makes the order the same every run.
   */
  readonly metadataBeforeFirstAppendEnds?: boolean;
  /**
   * `false`: the harness posts commands and reads state without a user gesture, as VS Code does.
   * Chromium then refuses autoplay until the learner acts in the page (#12 D3). By default the
   * harness runs as Playwright's `page.evaluate` does, as a user gesture, so autoplay is allowed.
   */
  readonly userGestures?: boolean;
}

export interface PlayerHarness {
  post(command: PlayerCommand): Promise<void>;
  /** Posts several commands in one go, so the page receives them back to back. */
  postAll(commands: readonly PlayerCommand[]): Promise<void>;
  events(): Promise<PlayerEvent[]>;
  /** Waits until the player has sent an event matching `expected` (a partial event). */
  waitForEvent(expected: Partial<PlayerEvent>): Promise<void>;
  video(): Promise<VideoState>;
  /** The hidden `<audio>` that plays an MP4 Lesson's sidecar sound. */
  sound(): Promise<SoundState>;
  /** The video's and the sidecar's playheads, read at the same moment. */
  playheads(): Promise<{ readonly video: number; readonly sound: number }>;
  /** Lets streams held by `holdAt` go on; returns once the player has read the bytes after it. */
  releaseStream(): Promise<void>;
  /** The Range header of every media request the player made, in order. */
  rangeRequests(): readonly string[];
}

export interface VideoState {
  readonly paused: boolean;
  /** Whether the native control bar is on (it shows on hover). */
  readonly controls: boolean;
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

export interface SoundState {
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly currentTime: number;
  readonly playbackRate: number;
  /** The sound file it holds: its `src`, empty when it holds none. */
  readonly source: string;
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
      path === '/media/sample.mp4' ||
      path === '/media/sidecar.mp4' ||
      path === '/media/sidecar.mp3'
    ) {
      const contentType = path.endsWith('.mp4')
        ? 'video/mp4'
        : path.endsWith('.mp3')
          ? 'audio/mpeg'
          : 'video/webm';
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
      soundCodecs,
      otherCodecs,
      tuning,
      holdAt,
      metadataFirst,
    }: {
      aac: boolean | undefined;
      soundCodecs: readonly string[] | undefined;
      otherCodecs: readonly (readonly [string, string])[];
      tuning: PlayerTuning | undefined;
      holdAt: number | undefined;
      metadataFirst: boolean;
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
      if (metadataFirst) {
        const addSourceBuffer = Object.getOwnPropertyDescriptor(
          MediaSource.prototype,
          'addSourceBuffer',
        )?.value as (this: MediaSource, type: string) => SourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (this: MediaSource, type: string) {
          const buffer = addSourceBuffer.call(this, type);
          let metadata = false;
          let first = true;
          let release: (() => void) | undefined;
          // Captured at the document, so it runs before the player's own listener on the video;
          // the held `updateend` follows a task later, after that listener.
          document.addEventListener(
            'loadedmetadata',
            () => {
              metadata = true;
              const held = release;
              release = undefined;
              if (held !== undefined) {
                setTimeout(held, 0);
              }
            },
            { capture: true, once: true },
          );
          // Added before the player's listeners, so it can stop the event reaching them.
          buffer.addEventListener('updateend', (event) => {
            if (!first || metadata) {
              first = false;
              return;
            }
            first = false;
            event.stopImmediatePropagation();
            release = () => buffer.dispatchEvent(new Event('updateend'));
          });
          return buffer;
        };
      }
      const sent: unknown[] = [];
      window.followalongSent = sent;
      // VS Code keeps a webview's state across reloads of its page; the tab's session storage does
      // too, and Playwright's `page.reload()` keeps it.
      const stateKey = 'followalong-webview-state';
      Object.defineProperty(window, 'acquireVsCodeApi', {
        value: () => ({
          postMessage: (message: unknown) => sent.push(message),
          getState: (): unknown => {
            const stored = sessionStorage.getItem(stateKey);
            return stored === null ? undefined : JSON.parse(stored);
          },
          setState: (state: unknown) => {
            sessionStorage.setItem(stateKey, JSON.stringify(state));
            return state;
          },
        }),
      });
      const original = HTMLMediaElement.prototype.canPlayType.bind(document.createElement('video'));
      HTMLMediaElement.prototype.canPlayType = (type: string) => {
        if (aac !== undefined && type.includes('mp4a.40')) {
          return aac ? 'probably' : '';
        }
        const codec = otherCodecs.find(
          ([, string]) => type.startsWith('audio/mp4') && type.includes(`"${string}"`),
        )?.[0];
        if (soundCodecs !== undefined && codec !== undefined) {
          return soundCodecs.includes(codec) ? 'probably' : '';
        }
        return original(type);
      };
    },
    {
      aac: options.aac,
      soundCodecs: options.soundCodecs,
      otherCodecs: pageSoundCodecs,
      tuning: options.tuning,
      holdAt: options.holdAt,
      metadataFirst: options.metadataBeforeFirstAppendEnds ?? false,
    },
  );
  await page.goto(`${origin}/`);

  const evaluate = await evaluator(page, options.userGestures ?? true);
  const events = () => evaluate(() => (window.followalongSent ?? []) as PlayerEvent[], undefined);
  return {
    async post(command) {
      await evaluate((message) => {
        window.postMessage(message, '*');
      }, command);
    },
    async postAll(commands) {
      await evaluate((messages) => {
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
    sound: () =>
      evaluate((): SoundState => {
        const element = document.querySelector('audio');
        if (element === null) {
          throw new Error('The player page has no <audio> element.');
        }
        return {
          paused: element.paused,
          muted: element.muted,
          volume: element.volume,
          currentTime: element.currentTime,
          playbackRate: element.playbackRate,
          source: element.getAttribute('src') ?? '',
        };
      }, undefined),
    playheads: () =>
      evaluate(() => {
        const video = document.querySelector('video');
        const audio = document.querySelector('audio');
        if (video === null || audio === null) {
          throw new Error('The player page has no <video> or no <audio> element.');
        }
        return { video: video.currentTime, sound: audio.currentTime };
      }, undefined),
    video: () =>
      evaluate((): VideoState => {
        const element = document.querySelector('video');
        if (element === null) {
          throw new Error('The player page has no <video> element.');
        }
        const decoded = element as HTMLVideoElement & {
          webkitAudioDecodedByteCount: number;
          webkitVideoDecodedByteCount: number;
        };
        return {
          paused: element.paused,
          controls: element.controls,
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
      }, undefined),
  };
}

type Evaluate = <Result, Arg>(run: (arg: Arg) => Result, arg: Arg) => Promise<Awaited<Result>>;

/** Runs `run(arg)` in the page, as a user gesture (Playwright's way) or not (VS Code's). */
async function evaluator(page: Page, userGestures: boolean): Promise<Evaluate> {
  if (userGestures) {
    return async (run, arg) =>
      (await page.evaluate(run as (value: unknown) => unknown, arg as unknown)) as never;
  }
  const session = await page.context().newCDPSession(page);
  return async (run, arg) => {
    const { result, exceptionDetails } = (await session.send('Runtime.evaluate', {
      expression: `(${run.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    })) as { result: { value?: unknown }; exceptionDetails?: { text: string } };
    if (exceptionDetails !== undefined) {
      throw new Error(`evaluate in the player page failed: ${exceptionDetails.text}`);
    }
    return result.value as never;
  };
}

function matches(event: PlayerEvent, expected: Partial<PlayerEvent>): boolean {
  return Object.entries(expected).every(
    ([key, value]) => (event as unknown as Record<string, unknown>)[key] === value,
  );
}

/**
 * Where things are on the player page. Chromium's native control bar sits along the bottom of
 * the video: its timeline about 22 px above the bottom edge, its buttons about 48 px above it
 * (play on the left; mute, then fullscreen, on the right, as the page turns the overflow menu off).
 */
export async function spots(page: Page) {
  const box = await page.locator('video').boundingBox();
  if (box === null) {
    throw new Error('the video is not on screen');
  }
  const bottom = box.y + box.height;
  return {
    picture: { x: box.x + box.width / 2, y: box.y + box.height / 3 },
    playButton: { x: box.x + 24, y: bottom - 48 },
    muteButton: { x: box.x + box.width - 72, y: bottom - 48 },
    timeline: (fraction: number) => ({
      x: box.x + 16 + (box.width - 32) * fraction,
      y: bottom - 22,
    }),
  };
}

/** The blank page beside each page under test that reads its screenshots. */
const scratchPages = new WeakMap<Page, Promise<Page>>();

/**
 * The blank page that reads `page`'s screenshots, opened once in the same browser context: the
 * context closes it with the test. A page per screenshot would start a renderer each time, and
 * the load slows the timing-sensitive tests running beside it.
 */
function scratchPage(page: Page): Promise<Page> {
  let scratch = scratchPages.get(page);
  if (scratch === undefined) {
    scratch = page.context().newPage();
    scratchPages.set(page, scratch);
  }
  return scratch;
}

/** How wide, at most, {@link screenshotPixels} draws a screenshot: a wider one is drawn smaller. */
const widestDrawn = 128;

/**
 * The RGB values of a screenshot of `clip` of the page. A screenshot wider than
 * {@link widestDrawn} px is drawn that wide, so its pixels blend into the mean of each area. Read
 * in a scratch page, so no image library is needed.
 */
async function screenshotPixels(
  page: Page,
  clip: NonNullable<PageScreenshotOptions['clip']>,
): Promise<readonly (readonly [number, number, number])[]> {
  // A JPEG is quicker to make than a PNG, and close enough for a mean or a white icon.
  const shot = await page.screenshot({ clip, type: 'jpeg', quality: 90 });
  return (await scratchPage(page)).evaluate(
    async ({ data, widest }) => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${data}`;
      await image.decode();
      const scale = Math.min(1, widest / image.width);
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) {
        throw new Error('no 2d canvas');
      }
      context.drawImage(image, 0, 0, width, height);
      const { data: pixels } = context.getImageData(0, 0, width, height);
      const rgb: [number, number, number][] = [];
      for (let index = 0; index < pixels.length; index += 4) {
        rgb.push([pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0]);
      }
      return rgb;
    },
    { data: shot.toString('base64'), widest: widestDrawn },
  );
}

/**
 * Whether Chromium's native control bar is on screen: its play/pause icon is drawn in white at
 * the left end of the button row, where the fixture video has no white.
 */
export async function controlBarShown(page: Page): Promise<boolean> {
  const box = await page.locator('video').boundingBox();
  if (box === null) {
    throw new Error('the video is not on screen');
  }
  const pixels = await screenshotPixels(page, {
    x: box.x + 12,
    y: box.y + box.height - 60,
    width: 24,
    height: 24,
  });
  return pixels.filter((pixel) => pixel.every((value) => value > 220)).length >= 10;
}

/** How bright the whole page looks, from 0 (black) to 255 (white): the mean of a screenshot. */
export async function pageBrightness(page: Page): Promise<number> {
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('the page has no fixed viewport');
  }
  const pixels = await screenshotPixels(page, { x: 0, y: 0, ...viewport });
  const total = pixels.reduce((sum, [red, green, blue]) => sum + red + green + blue, 0);
  return total / (pixels.length * 3);
}
