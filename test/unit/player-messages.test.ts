import { describe, expect, it } from 'vitest';

import { isZoomView } from '../../src/player/zoom.js';
import { parsePlayerCommand, parsePlayerEvent } from '../../src/protocol/player-messages.js';

describe('the zoom messages of the player protocol', () => {
  it('accept zoom reset, and nothing else for now', () => {
    expect(parsePlayerCommand({ type: 'zoom', action: 'reset' })).toEqual({
      type: 'zoom',
      action: 'reset',
    });
    for (const action of ['in', 'out', 'areaMode', undefined, 1, null]) {
      expect(parsePlayerCommand({ type: 'zoom', action })).toBeUndefined();
    }
    expect(parsePlayerCommand({ type: 'zoom' })).toBeUndefined();
  });

  it('accept zoomChanged with a level from 1 to 8×', () => {
    for (const level of [1, 1.25, 2.44140625, 8]) {
      expect(parsePlayerEvent({ type: 'zoomChanged', level })).toEqual({
        type: 'zoomChanged',
        level,
      });
    }
  });

  it('drop zoomChanged without a level the page can show', () => {
    for (const level of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -2,
      0,
      0.5,
      8.01,
      1e308,
      '2',
      null,
      undefined,
    ]) {
      expect(parsePlayerEvent({ type: 'zoomChanged', level })).toBeUndefined();
    }
    expect(parsePlayerEvent({ type: 'zoomChanged' })).toBeUndefined();
  });
});

describe('a zoom view stored by an earlier page', () => {
  it('is used when it is a view the player can show', () => {
    expect(isZoomView({ level: 1, left: 0, top: 0 })).toBe(true);
    expect(isZoomView({ level: 4, left: 0.25, top: 0.75 })).toBe(true);
    expect(isZoomView({ level: 8, left: 0.875, top: 0 })).toBe(true);
  });

  it('is ignored when it is damaged or from another version', () => {
    for (const stored of [
      undefined,
      null,
      'zoom',
      4,
      {},
      // An older shape, in pixels.
      { z: 4, tx: -1280, ty: -720 },
      { level: 4, left: 0.25 },
      { level: '4', left: 0.25, top: 0.25 },
      { level: Number.NaN, left: 0, top: 0 },
      { level: Number.POSITIVE_INFINITY, left: 0, top: 0 },
      { level: 0.5, left: 0, top: 0 },
      { level: 9, left: 0, top: 0 },
      // Reads 1× but is not the whole picture: the player never makes such a view.
      { level: 1.02, left: 0, top: 0 },
      { level: 4, left: -0.1, top: 0 },
      // Off the picture: at 4× the shown area starts at 0.75 at most.
      { level: 4, left: 0.8, top: 0 },
      { level: 2, left: 0, top: Number.NaN },
    ]) {
      expect(isZoomView(stored), JSON.stringify(stored)).toBe(false);
    }
  });
});
