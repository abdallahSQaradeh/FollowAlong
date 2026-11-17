/**
 * The PDF viewer's script, which runs in its webview (ADR 0021): it draws a PDF page by page with
 * pdf.js and lets the learner zoom. It draws pages only: no text layer, no annotation layer and
 * no scripting layer, so a link in a PDF is not clickable and nothing in the file runs. The page
 * (`renderPdfViewerPage`) hands it the PDF's address and the pdf.js worker's source.
 */
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

import { type PdfViewerEvent } from '../protocol/pdf-viewer-messages.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    /** The pdf.js worker's source, put there by the page. */
    followalongPdfWorker?: string;
  }
}

const vscode = acquireVsCodeApi();
const zoomStep = 1.25;
const zoomLimits = { min: 0.25, max: 5 } as const;
/** Pages are drawn when they come within this distance of the visible area. */
const drawAhead = '600px';

function report(event: PdfViewerEvent): void {
  vscode.postMessage(event);
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The PDF viewer page has no #${id}.`);
  }
  return found;
}

interface PageView {
  readonly box: HTMLDivElement;
  readonly number: number;
  proxy?: PDFPageProxy;
  task?: RenderTask | undefined;
  canvas?: HTMLCanvasElement | undefined;
}

async function open(): Promise<void> {
  const pagesElement = element('pages');
  const status = element('status');
  const label = element('level');
  const position = element('position');

  const source = window.followalongPdfWorker;
  if (source === undefined) {
    throw new Error('The PDF viewer page has no worker.');
  }
  GlobalWorkerOptions.workerPort = new Worker(
    URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
  );

  const loading = getDocument({
    url: document.body.dataset.pdf ?? '',
    // Nothing outside the page is read: no fonts, CMaps or decoders by URL, and no forms.
    enableXfa: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const doc: PDFDocumentProxy = await loading.promise;
  const first = await doc.getPage(1);
  const natural = first.getViewport({ scale: 1 });

  /** `0` means "fit the width of the window". */
  let zoom = 0;
  let scale = 1;
  const views: PageView[] = [];

  const fitScale = (): number =>
    Math.max(zoomLimits.min, (pagesElement.clientWidth - 32) / natural.width);

  const size = (view: PageView, viewport: { width: number; height: number }): void => {
    view.box.style.width = `${String(Math.floor(viewport.width))}px`;
    view.box.style.height = `${String(Math.floor(viewport.height))}px`;
  };

  const clear = (view: PageView): void => {
    view.task?.cancel();
    view.task = undefined;
    view.canvas?.remove();
    view.canvas = undefined;
  };

  const draw = async (view: PageView): Promise<void> => {
    if (view.canvas !== undefined) {
      return;
    }
    const proxy = view.proxy ?? (await doc.getPage(view.number));
    view.proxy = proxy;
    const viewport = proxy.getViewport({ scale });
    size(view, viewport);
    const ratio = window.devicePixelRatio;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${String(Math.floor(viewport.width))}px`;
    canvas.style.height = `${String(Math.floor(viewport.height))}px`;
    view.canvas = canvas;
    view.box.append(canvas);
    const task = proxy.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    view.task = task;
    try {
      await task.promise;
    } catch (error) {
      // A drawing cancelled by a zoom or by scrolling away is not a failure, and not a page drawn:
      // the page is drawn again when it comes back into view.
      if (error instanceof Error && error.name === 'RenderingCancelledException') {
        return;
      }
      throw error;
    }
    if (view.number === 1) {
      report({ type: 'rendered', pages: doc.numPages });
    }
  };

  const visible = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const view = views[Number((entry.target as HTMLElement).dataset.page) - 1];
        if (view === undefined) {
          continue;
        }
        if (entry.isIntersecting) {
          draw(view).catch((error: unknown) => {
            report({ type: 'failed', message: String(error) });
          });
        } else {
          clear(view);
        }
      }
    },
    { root: pagesElement, rootMargin: drawAhead },
  );

  const layout = (): void => {
    scale = zoom === 0 ? fitScale() : zoom;
    label.textContent = `${String(Math.round(scale * 100))}%`;
    const viewport = first.getViewport({ scale });
    for (const view of views) {
      clear(view);
      size(view, view.proxy?.getViewport({ scale }) ?? viewport);
      // An observed box reports again when it is observed again.
      visible.unobserve(view.box);
      visible.observe(view.box);
    }
  };

  for (let number = 1; number <= doc.numPages; number += 1) {
    const box = document.createElement('div');
    box.className = 'page';
    box.dataset.page = String(number);
    pagesElement.append(box);
    views.push({ box, number, ...(number === 1 ? { proxy: first } : {}) });
  }
  status.hidden = true;
  layout();

  const zoomBy = (factor: number): void => {
    const next = Math.min(zoomLimits.max, Math.max(zoomLimits.min, scale * factor));
    zoom = next;
    layout();
  };
  element('zoom-in').addEventListener('click', () => {
    zoomBy(zoomStep);
  });
  element('zoom-out').addEventListener('click', () => {
    zoomBy(1 / zoomStep);
  });
  element('zoom-fit').addEventListener('click', () => {
    zoom = 0;
    layout();
  });
  window.addEventListener('resize', () => {
    if (zoom === 0) {
      layout();
    }
  });
  pagesElement.addEventListener('scroll', () => {
    const top = pagesElement.scrollTop + pagesElement.clientHeight / 3;
    const current = views.findLast((view) => view.box.offsetTop - pagesElement.offsetTop <= top);
    position.textContent = `${String(current?.number ?? 1)} / ${String(doc.numPages)}`;
  });
  position.textContent = `1 / ${String(doc.numPages)}`;
}

open().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  element('status').textContent = `This PDF can't be shown: ${message}`;
  element('status').hidden = false;
  report({ type: 'failed', message });
});
