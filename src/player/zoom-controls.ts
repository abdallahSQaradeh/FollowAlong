/**
 * The player's zoom controls (ADR 0037, 0087, 0088): the box the learner drags over the picture,
 * the pan, the wheel, the zoom toolbar, and what the page shows and keeps in its webview state. What
 * a click on the picture does stays with playback in `main.ts`; it asks these controls whether the
 * page is zoomed, and whether the click ends a drag.
 */
import { zoomLabel } from '../protocol/player-messages.js';
import type { Interactions } from './interactions.js';
import {
  isZoomView,
  panBy,
  wholePicture,
  zoomAt,
  zoomBy,
  zoomStep,
  zoomToBox,
  zoomTransform,
  type ZoomView,
} from './zoom.js';

/** How far the pointer moves, in px, before a press on the picture is a drag and not a click. */
const dragThreshold = 6;
/** How far the wheel turns, in px of `deltaY`, for one step of {@link zoomStep}: a notch of a mouse. */
const wheelNotch = 100;
/** A turn of the wheel this long after the one before starts a new gesture, and drops its rest. */
const wheelIdleMs = 250;
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
  /**
   * Whether the player holds the native control bar back for another reason (the sound of an MP4
   * Lesson is still awaited, ADR 0034): a zoom back to 1× then leaves it off.
   */
  readonly controlsHeldBack: () => boolean;
}

/** The pointer that pressed on the picture, where it pressed, and whether it is a drag yet. */
interface Press {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  /** What a drag of this press does: set when it began, and kept until it ends. */
  readonly kind: 'box' | 'pan';
  /** What the page showed when the press began: a pan moves it from there. */
  readonly view: ZoomView;
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
  /** The turn of the wheel, in px of `deltaY`, not yet enough for a step, and when it came. */
  private wheelLeftover = 0;
  private lastWheelAt = 0;
  /** Set when a drag ended: the `click` the browser fires after it is not a click. */
  private dragEnded = false;
  private readonly levelOutput: HTMLElement;
  private readonly areaButton: HTMLElement;

  constructor(private readonly options: ZoomControlsOptions) {
    this.levelOutput = part(options.toolbar, '.zoom-level');
    this.areaButton = part(options.toolbar, '[data-zoom="area"]');
    this.listenToDrags();
    this.listenToWheel();
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

  /** What part of the picture the page shows now. */
  get shown(): ZoomView {
    return this.view;
  }

  /**
   * Shows `view`: the zoom of the page this one replaces in another spot (ADR 0049). It ends
   * area mode and drops a box being drawn, as a reset does.
   */
  showView(view: ZoomView): void {
    this.endPress(true);
    this.setAreaMode(false);
    this.show(view);
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
    this.keep(view);
    this.render(view);
  }

  /** Keeps `view` in the webview state. */
  private keep(view: ZoomView): void {
    // View state, not the Lesson's: it stays for the next Lesson and a reloaded page.
    this.options.state.setState({ zoom: view } satisfies PageState);
  }

  /** Shows `view`, and reports a new level. */
  private render(view: ZoomView): void {
    const { media, zoomChanged } = this.options;
    const before = this.view.level;
    this.view = view;
    media.style.transform = zoomTransform(view);
    // The native control bar would be enlarged with the picture: it is off while zoomed, and the
    // overlay then covers the whole player, so the strip along the bottom is picture too.
    media.controls = !this.zoomed && !this.options.controlsHeldBack();
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
   * A drag on the picture either draws a box, and the player zooms to the area in it, or pans the
   * zoomed picture (ADR 0087). Which, is fixed when the press begins. The drag is one gesture for
   * Focus return (ADR 0009): focus is handed back once it ends, not during it.
   */
  private listenToDrags(): void {
    const { overlay, box, interactions } = this.options;
    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) {
        return;
      }
      // A drag whose `click` never came must not swallow this press's click.
      this.dragEnded = false;
      // A drag pans only while zoomed, where there is more picture to move to; Shift, or area
      // mode, asks for a new area instead (ADR 0087).
      const draws = !this.zoomed || this.areaMode || event.shiftKey;
      this.press = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        kind: draws ? 'box' : 'pan',
        view: this.view,
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
        document.body.classList.toggle('panning', press.kind === 'pan');
        interactions.beginGesture(event.pointerId);
      }
      if (press.kind === 'pan') {
        const stage = this.stage();
        this.render(
          panBy(
            press.view,
            (event.clientX - press.x) / stage.width,
            (event.clientY - press.y) / stage.height,
          ),
        );
        return;
      }
      box.style.left = `${String(area.x)}px`;
      box.style.top = `${String(area.y)}px`;
      box.style.width = `${String(area.width)}px`;
      box.style.height = `${String(area.height)}px`;
      box.removeAttribute('hidden');
    });
    overlay.addEventListener('pointerup', (event) => {
      if (this.press?.pointerId === event.pointerId) {
        const { kind } = this.press;
        const area = rectangle(this.press, event.clientX, event.clientY);
        this.endPress(this.press.dragging);
        if (kind === 'box') {
          this.zoomTo(area);
        }
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
   * The wheel zooms toward the cursor, a step of {@link zoomStep} for each {@link wheelNotch} it
   * turns. A trackpad's many small turns add up to steps, so each one that counts is a zoom the
   * learner sees (a level that reads 1× is the whole picture). A turn is not a click, and it does
   * not take focus from the editor, so there is nothing to hand back.
   */
  private listenToWheel(): void {
    this.options.overlay.addEventListener(
      'wheel',
      (event) => {
        // The page must not scroll, nor the browser zoom on a Ctrl+wheel or a pinch.
        event.preventDefault();
        // A turn to the side (Shift+wheel on some systems) is not a zoom, nor the end of one.
        if (event.deltaY === 0) {
          return;
        }
        // A drag under way owns the view: it would be drawn over, or moved from, a view that moved.
        if (this.press !== undefined) {
          return;
        }
        const turned = event.deltaY;
        const reversed = Math.sign(turned) !== Math.sign(this.wheelLeftover);
        const pause = event.timeStamp - this.lastWheelAt > wheelIdleMs;
        this.lastWheelAt = event.timeStamp;
        const total = (reversed || pause ? 0 : this.wheelLeftover) + turned;
        const steps = Math.trunc(total / wheelNotch);
        this.wheelLeftover = total - steps * wheelNotch;
        if (steps === 0) {
          return;
        }
        // Turning away from the learner (a negative `deltaY`) zooms in.
        this.show(zoomAt(this.view, zoomStep ** -steps, this.onStage(event)));
      },
      { passive: false },
    );
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
    document.body.classList.remove('panning');
    this.options.box.setAttribute('hidden', '');
    if (!press.dragging) {
      return;
    }
    if (press.kind === 'pan') {
      // The pan moved the view without keeping it: it is kept once, where the pan ended.
      this.keep(this.view);
    }
    this.dragEnded = clickFollows;
    this.setAreaMode(false);
    this.options.interactions.endGesture(press.pointerId);
  }

  /** The player's box, in px of the page: at 1× the overlay stops above the native control bar. */
  private stage(): DOMRect {
    return (this.options.overlay.parentElement ?? this.options.overlay).getBoundingClientRect();
  }

  /** Where the pointer of `event` is on the player, in fractions of its width and height. */
  private onStage(event: MouseEvent): { x: number; y: number } {
    const stage = this.stage();
    return {
      x: (event.clientX - stage.x) / stage.width,
      y: (event.clientY - stage.y) / stage.height,
    };
  }

  /** Zooms to the area of a box drawn over the picture, when it is big enough to mean one. */
  private zoomTo(area: { x: number; y: number; width: number; height: number }): void {
    if (area.width < smallestBox || area.height < smallestBox) {
      return;
    }
    const stage = this.stage();
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
