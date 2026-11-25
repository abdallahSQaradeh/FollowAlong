/**
 * PROTOTYPE, throwaway (ticket "How does a YouTube Lesson feel in the player?"). Never merge.
 *
 * A YouTube Lesson stands in as a file named `*.youtube.webm` in a local Course whose text is a
 * YouTube URL or video ID, so the core loads it like any WebM Lesson (no sidecar). The player
 * panel turns its resource URI into `youtube:<id>?…`, which the page plays through a relay page.
 *
 * This module also serves that relay on `http://127.0.0.1:<port>/relay.html`, and `/echo`, which
 * records the Referer, Origin and Sec-Fetch headers of whatever frames it, to measure what an
 * iframe inside a VS Code webview sends.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { Logger } from '../../core/logger.js';

const standInSuffix = '.youtube.webm';

/** Whether `path` is a stand-in file for a YouTube Lesson. */
export function isYouTubeStandIn(path: string): boolean {
  return path.toLowerCase().endsWith(standInSuffix);
}

/** The video ID in a YouTube URL (watch, youtu.be, embed, shorts) or a bare ID. */
function videoIdOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^[\w-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const match = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/.exec(trimmed);
  return match?.[1];
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return value === undefined ? '(none)' : String(value);
}

export class PrototypeYouTube implements vscode.Disposable {
  private readonly server: Server;
  /** The local server's origin, once it listens (long before the first Lesson loads). */
  private origin: string | undefined;

  constructor(
    private readonly extensionPath: string,
    private readonly logger: Logger,
  ) {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/relay.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          readFileSync(join(this.extensionPath, 'media', 'prototype-youtube-relay.html')),
        );
        return;
      }
      if (url.pathname === '/echo') {
        const from = url.searchParams.get('from') ?? '?';
        const referer = header(request, 'referer');
        this.logger.log({
          level: 'info',
          message: `[prototype] Referer measured, frame in ${from}: Referer=${referer}; Origin=${header(request, 'origin')}; Sec-Fetch-Site=${header(request, 'sec-fetch-site')}; Sec-Fetch-Dest=${header(request, 'sec-fetch-dest')}`,
        });
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`Referer: ${referer}`);
        return;
      }
      if (url.pathname === '/paint') {
        // A frame on another site (localhost, not 127.0.0.1): does a third-level frame paint?
        this.logger.log({
          level: 'info',
          message: `[prototype] paint-test frame requested by ${header(request, 'referer')}`,
        });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><body style="margin:0;background:#1f8a4c;color:#fff;font:12px monospace;display:grid;place-items:center;height:100vh">3rd-level frame paints</body>',
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on('error', (error) => {
      this.logger.log({ level: 'error', message: `[prototype] relay server: ${error.message}` });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address !== null && typeof address !== 'string') {
        this.origin = `http://127.0.0.1:${String(address.port)}`;
        this.logger.log({ level: 'info', message: `[prototype] relay server on ${this.origin}` });
      }
    });
    this.server = server;
  }

  /**
   * The URI the page loads for a stand-in file: `youtube:<id>?relay=…&echo=…&focusReturn=…`.
   * `relay` is empty in direct mode (YouTube framed straight from the webview).
   */
  uriFor(path: string): string {
    const { origin } = this;
    if (origin === undefined) {
      throw new Error('The prototype relay server is not listening yet.');
    }
    const text = readFileSync(path, 'utf8');
    const id = videoIdOf(text);
    if (id === undefined) {
      throw new Error(`No YouTube video ID in ${path}: ${text.slice(0, 80)}`);
    }
    const config = vscode.workspace.getConfiguration('followalong.prototype');
    const mode = config.get<string>('youtubeRelay', 'local').trim();
    const relay =
      mode === 'direct' ? '' : mode === 'local' || mode === '' ? `${origin}/relay.html` : mode;
    const query = new URLSearchParams({
      relay,
      echo: `${origin}/echo`,
      paint: `${origin.replace('127.0.0.1', 'localhost')}/paint`,
      focusReturn: config.get<boolean>('youtubeFocusReturn', true) ? '1' : '0',
    });
    this.logger.log({
      level: 'info',
      message: `[prototype] YouTube Lesson ${id}, relay: ${relay === '' ? 'none (direct)' : relay}`,
    });
    return `youtube:${id}?${query.toString()}`;
  }

  dispose(): void {
    this.server.close();
  }
}
