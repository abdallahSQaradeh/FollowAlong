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

describe('the spot move messages of the player protocol', () => {
  const zoom = { level: 2, left: 0.25, top: 0.5 };

  it('accept takeSnapshot, and restore with a view the player can show', () => {
    expect(parsePlayerCommand({ type: 'takeSnapshot' })).toEqual({ type: 'takeSnapshot' });
    expect(parsePlayerCommand({ type: 'restore', zoom: { ...zoom, extra: 1 } })).toEqual({
      type: 'restore',
      zoom,
    });
    for (const bad of [
      undefined,
      null,
      { level: 2, left: 0.75, top: 0 },
      { level: 9, left: 0, top: 0 },
    ]) {
      expect(parsePlayerCommand({ type: 'restore', zoom: bad })).toBeUndefined();
    }
  });

  it('accept a snapshot with or without the Lesson the page holds', () => {
    const lesson = { lessonId: 'a.webm', loadId: 3, position: 12.5, playing: true };
    expect(parsePlayerEvent({ type: 'snapshot', snapshot: { rate: 1.5, zoom, lesson } })).toEqual({
      type: 'snapshot',
      snapshot: { rate: 1.5, zoom, lesson },
    });
    expect(parsePlayerEvent({ type: 'snapshot', snapshot: { rate: 1, zoom } })).toEqual({
      type: 'snapshot',
      snapshot: { rate: 1, zoom },
    });
  });

  it('drop a snapshot that is not one', () => {
    const lesson = { lessonId: 'a.webm', position: 1, playing: false };
    for (const snapshot of [
      undefined,
      { rate: 0, zoom, lesson },
      { rate: 1, zoom: { level: 0.5, left: 0, top: 0 }, lesson },
      { rate: 1, zoom, lesson: { ...lesson, position: -1 } },
      { rate: 1, zoom, lesson: { ...lesson, playing: 'yes' } },
      { rate: 1, zoom, lesson: { ...lesson, lessonId: 4 } },
      { rate: 1, zoom, lesson: { ...lesson, loadId: 1.5 } },
      { rate: 1, zoom, lesson: 'a.webm' },
    ]) {
      expect(parsePlayerEvent({ type: 'snapshot', snapshot })).toBeUndefined();
    }
  });
});
