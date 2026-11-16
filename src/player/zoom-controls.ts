/**
 * The player's zoom controls (ADR 0037): the box the learner drags over the picture, the zoom
 * toolbar, and what the page shows and keeps in its webview state. What a click on the picture
 * does stays with playback in `main.ts`; it asks these controls whether the page is zoomed, and
 * whether the click ends a drag.
 */
import { zoomLabel } from '../protocol/player-messages.js';
import type { Interactions } from './interactions.js';
import {
  isZoomView,
  wholePicture,
  zoomBy,
  zoomStep,
  zoomToBox,
  zoomTransform,
  type ZoomView,
} from './zoom.js';

/** How far the pointer moves, in px, before a press on the picture is a drag and not a click. */
const dragThreshold = 6;
/** A box smaller than this, in px either way, zooms to nothing. */
const smallestBox = 12;

/** VS Code's webview state: it outlives a reload of the page. */
export interface WebviewState {
  getState(): unknown;
  setState(state: unknown): unknown;
}

/** What the page keeps in the webview state. */
interface PageState {
  readonly zoom: ZoomView;
}

export interface ZoomControlsOptions {
  readonly media: HTMLVideoElement;
  /** The transparent layer over the picture that takes the learner's pointer. */
  readonly overlay: HTMLElement;
  /** The box drawn while the learner drags. */
  readonly box: HTMLElement;
  /** The toolbar: an element with `.zoom-level`, and buttons with `data-zoom`. */
  readonly toolbar: HTMLElement;
  readonly interactions: Interactions;
  readonly state: WebviewState;
  /** Reports a new zoom level to the extension. */
  readonly zoomChanged: (level: number) => void;
}

/** The pointer that pressed on the picture, where it pressed, and whether it is a drag yet. */
interface Press {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  dragging: boolean;
}

/** One element of the page, which the page's own HTML always has. */
function part(parent: ParentNode, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`The player page has no ${selector}.`);
  }
  return element;
}

export class ZoomControls {
  /** What part of the picture the player shows now. */
  private view: ZoomView = wholePicture;
  /** Set by the toolbar's area button: the next drag draws a box, whatever the zoom. */
  private areaMode = false;
  private press: Press | undefined;
  /** Set when a drag ended: the `click` the browser fires after it is not a click. */
  private dragEnded = false;
  private readonly levelOutput: HTMLElement;
  private readonly areaButton: HTMLElement;

  constructor(private readonly options: ZoomControlsOptions) {
    this.levelOutput = part(options.toolbar, '.zoom-level');
    this.areaButton = part(options.toolbar, '[data-zoom="area"]');
    this.listenToDrags();
    this.listenToToolbar();
  }

  /** Whether the picture is zoomed in: a double-click then resets it. */
  get zoomed(): boolean {
    return this.view.level > 1;
  }

  /**
   * Whether the `click` the browser fires now ends a drag rather than being a click on the
   * picture. Asking clears it: the next click is a click again.
   */
  takeDragClick(): boolean {
    const ended = this.dragEnded;
    this.dragEnded = false;
    return ended;
  }

  /**
   * Shows the whole picture again (a double-click, the toolbar, the extension's `zoom` command).
   * It also ends area mode, and drops a box being drawn: it was drawn over the old view.
   */
  reset(): void {
    // The pointer is still down: its release fires a `click`, which must not play or pause.
    this.endPress(true);
    this.setAreaMode(false);
    this.show(wholePicture);
  }

  /** Shows the zoom a page before this one left in the webview state, if any. */
  restore(): void {
    const state = this.options.state.getState();
    const stored: unknown =
      typeof state === 'object' && state !== null && 'zoom' in state ? state.zoom : undefined;
    if (isZoomView(stored)) {
      this.show(stored);
    }
  }

  /** Shows `view`, keeps it in the webview state, and reports a new level. */
  private show(view: ZoomView): void {
    const { media, state, zoomChanged } = this.options;
    const before = this.view.level;
    this.view = view;
    // View state, not the Lesson's: it stays for the next Lesson and a reloaded page.
    state.setState({ zoom: view } satisfies PageState);
    media.style.transform = zoomTransform(view);
    // The native control bar would be enlarged with the picture: it is off while zoomed, and the
    // overlay then covers the whole player, so the strip along the bottom is picture too.
    media.controls = !this.zoomed;
    document.body.classList.toggle('zoomed', this.zoomed);
    this.levelOutput.textContent = zoomLabel(view.level);
    if (view.level !== before) {
      zoomChanged(view.level);
    }
  }

  private setAreaMode(on: boolean): void {
    this.areaMode = on;
    this.areaButton.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('area-mode', on);
  }

  /**
   * A drag on the picture draws a box, and the player zooms to the area in it. The drag is one
   * gesture for Focus return (ADR 0009): focus is handed back once it ends, not during it.
   */
  private listenToDrags(): void {
    const { overlay, box, interactions } = this.options;
    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) {
        return;
      }
      // A drag whose `click` never came must not swallow this press's click.
      this.dragEnded = false;
      this.press = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
      };
      overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener('pointermove', (event) => {
      const { press } = this;
      if (press?.pointerId !== event.pointerId) {
        return;
      }
      const area = rectangle(press, event.clientX, event.clientY);
      if (!press.dragging && area.width + area.height <= dragThreshold) {
        return;
      }
      if (!press.dragging) {
        press.dragging = true;
        interactions.beginGesture(event.pointerId);
      }
      box.style.left = `${String(area.x)}px`;
      box.style.top = `${String(area.y)}px`;
      box.style.width = `${String(area.width)}px`;
      box.style.height = `${String(area.height)}px`;
      box.removeAttribute('hidden');
    });
    overlay.addEventListener('pointerup', (event) => {
      if (this.press?.pointerId === event.pointerId) {
        const area = rectangle(this.press, event.clientX, event.clientY);
        this.endPress(this.press.dragging);
        this.zoomTo(area);
      }
    });
    // The browser took the pointer away (`pointercancel`), or the press lost its capture without
    // a `pointerup` reaching the picture (a blur, say): the drag ends, and zooms nothing.
    const cancel = (event: PointerEvent) => {
      if (this.press?.pointerId === event.pointerId) {
        this.endPress(false);
      }
    };
    overlay.addEventListener('pointercancel', cancel);
    overlay.addEventListener('lostpointercapture', cancel);
  }

  /**
   * Ends the press under way. A drag also ends its gesture and area mode: area mode is for the
   * next drag only, whether it zooms or not. `clickFollows`: the browser fires a `click` for it.
   */
  private endPress(clickFollows: boolean): void {
    const { press } = this;
    if (press === undefined) {
      return;
    }
    this.press = undefined;
    this.options.box.setAttribute('hidden', '');
    if (!press.dragging) {
      return;
    }
    this.dragEnded = clickFollows;
    this.setAreaMode(false);
    this.options.interactions.endGesture(press.pointerId);
  }

  /** Zooms to the area of a box drawn over the picture, when it is big enough to mean one. */
  private zoomTo(area: { x: number; y: number; width: number; height: number }): void {
    if (area.width < smallestBox || area.height < smallestBox) {
      return;
    }
    // Until #47 a plain drag also draws a box: at 1×, while zoomed and in area mode alike.
    // The player's box: at 1× the overlay stops above the native control bar.
    const stage = (
      this.options.overlay.parentElement ?? this.options.overlay
    ).getBoundingClientRect();
    this.show(
      zoomToBox(this.view, {
        x: (area.x - stage.x) / stage.width,
        y: (area.y - stage.y) / stage.height,
        width: area.width / stage.width,
        height: area.height / stage.height,
      }),
    );
  }

  /** The toolbar's buttons (story 61). Their presses hand focus back like any click (ADR 0009). */
  private listenToToolbar(): void {
    const actions: Readonly<Record<string, () => void>> = {
      in: () => {
        this.show(zoomBy(this.view, zoomStep));
      },
      out: () => {
        this.show(zoomBy(this.view, 1 / zoomStep));
      },
      area: () => {
        this.setAreaMode(!this.areaMode);
      },
      reset: () => {
        this.reset();
      },
    };
    for (const button of this.options.toolbar.querySelectorAll<HTMLElement>('[data-zoom]')) {
      const action = actions[button.dataset.zoom ?? ''];
      button.addEventListener('click', () => {
        action?.();
      });
    }
  }
}

/** The rectangle from where a press began to (`x`, `y`), in px of the page. */
function rectangle(start: { readonly x: number; readonly y: number }, x: number, y: number) {
  return {
    x: Math.min(start.x, x),
    y: Math.min(start.y, y),
    width: Math.abs(x - start.x),
    height: Math.abs(y - start.y),
  };
}
