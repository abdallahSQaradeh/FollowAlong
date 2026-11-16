/**
 * Seam 2 for the Resource preview pages (ADR 0021): the HTML and Markdown previews load in real
 * Chromium at a fake webview origin. They show the learner's page, resolve its relative files
 * against its own folder, and never run a script in it.
 *
 * The scripts these tests plant are blocked on purpose, and Chromium logs each block as a console
 * error. These tests open their own page, not the `page` fixture that echoes console errors into
 * `check-logs`, and assert on the blocks instead.
 */
import type { Page } from '@playwright/test';

import {
  renderHtmlPreviewPage,
  renderMarkdownPreviewPage,
} from '../../src/adapters/vscode/preview-pages.js';
import { expect, test } from './fixtures.js';

const origin = 'https://webview.followalong.test';
const baseHref = `${origin}/course/notes/`;
/** A 1 × 1 PNG. */
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** Opens `html` as the webview would show it, and returns what the browser reported about it. */
async function open(page: Page, html: string): Promise<string[]> {
  const reported: string[] = [];
  page.on('console', (message) => {
    reported.push(message.text());
  });
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: html });
    } else if (path === '/course/notes/pic.png') {
      await route.fulfill({ contentType: 'image/png', body: png });
    } else if (path === '/course/notes/style.css') {
      await route.fulfill({ contentType: 'text/css', body: 'h1 { color: rgb(0, 128, 0); }' });
    } else {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
  await page.goto(`${origin}/`);
  return reported;
}

test.describe('the HTML preview', () => {
  const html = `<!doctype html><html><head><title>Notes</title>
<link rel="stylesheet" href="style.css">
<script>document.body.dataset.ran = 'yes'; document.title = 'script ran';</script></head>
<body><h1>Closures</h1><img id="pic" src="pic.png" alt=""></body></html>`;

  test('shows the page, with its stylesheet and images from its own folder', async ({
    browser,
  }) => {
    const page = await browser.newPage();
    await open(page, renderHtmlPreviewPage({ cspSource: origin, baseHref, html }));
    const shown = page.frameLocator('iframe');

    await expect(shown.locator('h1')).toHaveText('Closures');
    await expect(shown.locator('h1')).toHaveCSS('color', 'rgb(0, 128, 0)');
    await expect
      .poll(() => shown.locator('#pic').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    await page.close();
  });

  test('runs none of the script in the page', async ({ browser }) => {
    const page = await browser.newPage();
    const reported = await open(page, renderHtmlPreviewPage({ cspSource: origin, baseHref, html }));
    const shown = page.frameLocator('iframe');
    await expect(shown.locator('h1')).toHaveText('Closures');

    await expect(shown.locator('body')).not.toHaveAttribute('data-ran', 'yes');
    await expect(page.frames()[1]?.title()).resolves.toBe('Notes');
    expect(reported.join('\n')).toMatch(/Blocked script execution/);
    await page.close();
  });

  test('cannot reach into the page around it', async ({ browser }) => {
    const page = await browser.newPage();
    await open(page, renderHtmlPreviewPage({ cspSource: origin, baseHref, html: '<h1>x</h1>' }));

    const sandbox = await page.locator('iframe').getAttribute('sandbox');

    expect(sandbox).toBe('');
    await page.close();
  });
});

test.describe('the Markdown preview', () => {
  const body = `<h1>Cheat sheet</h1><p>See <code>map</code>.</p><img id="pic" src="pic.png" alt="">
<script>document.title = 'script ran';</script>`;

  test('shows the rendered page, with images from the Markdown file’s folder', async ({
    browser,
  }) => {
    const page = await browser.newPage();
    await open(page, renderMarkdownPreviewPage({ cspSource: origin, baseHref, body }));

    await expect(page.locator('h1')).toHaveText('Cheat sheet');
    await expect
      .poll(() => page.locator('#pic').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    await page.close();
  });

  test('runs no script, not even one written in the Markdown', async ({ browser }) => {
    const page = await browser.newPage();
    const reported = await open(
      page,
      renderMarkdownPreviewPage({ cspSource: origin, baseHref, body }),
    );
    await expect(page.locator('h1')).toHaveText('Cheat sheet');

    await expect(page).toHaveTitle('FollowAlong preview');
    expect(reported.join('\n')).toMatch(/Content Security Policy/);
    await page.close();
  });
});
