/**
 * Seam 2 for the PDF viewer page (ADR 0021): the page the extension builds, with the built viewer
 * script and pdf.js worker, in real Chromium at a fake webview origin. It draws the PDF, zooms,
 * says so when the file is not a PDF, and fetches nothing from outside its own origin.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { renderPdfViewerPage } from '../../src/player/pdf-page.js';
import {
  parsePdfViewerEvent,
  type PdfViewerEvent,
} from '../../src/protocol/pdf-viewer-messages.js';
import { expect, test } from './fixtures.js';

const root = resolve(__dirname, '..', '..');
const origin = 'https://webview.followalong.test';

declare global {
  interface Window {
    /** Every message the viewer posted to the extension, in order. */
    followalongPdfSent?: unknown[];
  }
}

interface Opened {
  /** The addresses the page asked for outside its own origin. */
  readonly strangers: string[];
}

/** Opens the viewer on the file at `/doc.pdf`, which has the content `served`. */
async function openViewer(page: Page, served: Buffer | string): Promise<Opened> {
  const html = renderPdfViewerPage({
    cspSource: origin,
    nonce: 'c2VhbTItbm9uY2U',
    pdfUri: `${origin}/doc.pdf`,
    script: readFileSync(join(root, 'out', 'pdf', 'pdf-viewer.js'), 'utf8'),
    worker: readFileSync(join(root, 'out', 'pdf', 'pdf.worker.js'), 'utf8'),
  });
  const strangers: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')) {
      strangers.push(url);
    }
  });
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: html });
    } else if (path === '/doc.pdf') {
      await route.fulfill({ contentType: 'application/pdf', body: served });
    } else {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    window.followalongPdfSent = sent;
    Object.defineProperty(window, 'acquireVsCodeApi', {
      value: () => ({ postMessage: (message: unknown) => sent.push(message) }),
    });
  });
  await page.goto(`${origin}/`);
  return { strangers };
}

async function sent(page: Page): Promise<PdfViewerEvent[]> {
  const raw = await page.evaluate(() => window.followalongPdfSent ?? []);
  return raw.flatMap((message) => parsePdfViewerEvent(message) ?? []);
}

const sample = readFileSync(join(root, 'test', 'fixtures', 'pdf', 'sample.pdf'));

test('draws every page of the PDF and says how many there are', async ({ page }) => {
  await openViewer(page, sample);

  await expect.poll(() => sent(page)).toEqual([{ type: 'rendered', pages: 3 }]);
  await expect(page.locator('.page')).toHaveCount(3);
  await expect(page.locator('#position')).toHaveText('1 / 3');
  // The first page has ink on it: the text was drawn, not just a blank canvas.
  const inked = await page
    .locator('.page canvas')
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      return (
        data !== undefined &&
        Array.from(data).some((value, index) => index % 4 === 0 && value < 100)
      );
    });
  expect(inked).toBe(true);
});

test('zooms in and out, and fits the width again', async ({ page }) => {
  await openViewer(page, sample);
  await expect(page.locator('.page canvas').first()).toBeVisible();
  const width = async (): Promise<number> =>
    (await page.locator('.page').first().boundingBox())?.width ?? 0;
  const fitted = await width();
  await expect(page.locator('#level')).toHaveText(/%$/);

  await page.locator('#zoom-in').click();
  const larger = await width();
  await page.locator('#zoom-out').click();
  await page.locator('#zoom-out').click();
  const smaller = await width();
  await page.locator('#zoom-fit').click();

  expect(larger).toBeGreaterThan(fitted);
  expect(smaller).toBeLessThan(fitted);
  expect(await width()).toBeCloseTo(fitted, 0);
});

test('says so when the file is not a PDF', async ({ page }) => {
  await openViewer(page, 'this download was cut short');

  await expect(page.locator('#status')).toContainText("This PDF can't be shown");
  await expect.poll(async () => (await sent(page)).map((event) => event.type)).toEqual(['failed']);
});

test('fetches nothing from outside its own origin', async ({ page }) => {
  const opened = await openViewer(page, sample);
  await expect.poll(() => sent(page)).toEqual([{ type: 'rendered', pages: 3 }]);

  expect(opened.strangers).toEqual([]);
});
