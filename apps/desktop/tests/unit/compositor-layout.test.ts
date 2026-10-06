import { describe, expect, it } from 'vitest';
import {
  cameraRect,
  followCrop,
  followCropSize,
  mosaicLayout,
  type FollowZoom,
} from '../../src/shared/compositor-layout';
import type { Rect } from '../../src/shared/rect';

const FRAME = { width: 3440, height: 1440 };
const center = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

function run(target: { x: number; y: number }, steps: number, dtMs: number, zoom: FollowZoom = 2) {
  let rect: Rect | null = null;
  for (let i = 0; i < steps; i += 1) {
    rect = followCrop({ target, prev: rect, dtMs, zoom, frame: FRAME });
  }
  return rect as Rect;
}

describe('followCrop', () => {
  it('sizes the window as the frame over the zoom, with even sides', () => {
    expect(followCropSize(FRAME, 2)).toEqual({ width: 1720, height: 720 });
    expect(followCropSize(FRAME, 3)).toEqual({ width: 1146, height: 480 });
    const odd = followCropSize({ width: 1921, height: 1081 }, 1.5);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
  });

  it('starts centered on the mouse', () => {
    const rect = followCrop({
      target: { x: 1720, y: 720 },
      prev: null,
      dtMs: 0,
      zoom: 2,
      frame: FRAME,
    });
    expect(rect).toEqual({ x: 860, y: 360, width: 1720, height: 720 });
  });

  it('converges on a far-away mouse (within the dead zone)', () => {
    const rect = run({ x: 2400, y: 1000 }, 120, 33);
    const c = center(rect);
    expect(Math.abs(c.x - 2400)).toBeLessThanOrEqual(1720 * 0.1 + 2);
    expect(Math.abs(c.y - 1000)).toBeLessThanOrEqual(720 * 0.1 + 2);
  });

  it('is frame-rate independent', () => {
    const start = followCrop({
      target: { x: 500, y: 700 },
      prev: null,
      dtMs: 0,
      zoom: 2,
      frame: FRAME,
    });
    const target = { x: 3300, y: 700 };
    const oneStep = followCrop({ target, prev: start, dtMs: 100, zoom: 2, frame: FRAME });
    let prev = start;
    for (let i = 0; i < 10; i += 1) {
      prev = followCrop({ target, prev, dtMs: 10, zoom: 2, frame: FRAME });
    }
    expect(Math.abs(prev.x - oneStep.x)).toBeLessThanOrEqual(12);
  });

  it('moves about 63 % of the way in one time constant', () => {
    const start = followCrop({
      target: { x: 860, y: 720 },
      prev: null,
      dtMs: 0,
      zoom: 2,
      frame: FRAME,
    });
    const next = followCrop({
      target: { x: 2460, y: 720 },
      prev: start,
      dtMs: 180,
      zoom: 2,
      frame: FRAME,
    });
    // aims at the dead-zone edge (172 px short of the mouse)
    const expected = 860 + (2460 - 172 - 860) * (1 - Math.exp(-1));
    expect(center(next).x).toBeCloseTo(expected, -1);
  });

  it('does not pan for jitter inside the dead zone', () => {
    const start = followCrop({
      target: { x: 1720, y: 720 },
      prev: null,
      dtMs: 0,
      zoom: 2,
      frame: FRAME,
    });
    const next = followCrop({
      target: { x: 1720 + 100, y: 720 - 50 },
      prev: start,
      dtMs: 33,
      zoom: 2,
      frame: FRAME,
    });
    expect(next).toEqual(start);
  });

  it('stays inside the frame at every corner and keeps even sides', () => {
    for (const target of [
      { x: 0, y: 0 },
      { x: 3439, y: 0 },
      { x: 0, y: 1439 },
      { x: 3439, y: 1439 },
      { x: -500, y: 9999 },
    ]) {
      for (const zoom of [1.5, 2, 3] as const) {
        const rect = run(target, 200, 33, zoom);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(FRAME.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(FRAME.height);
        for (const value of [rect.width, rect.height]) expect(value % 2).toBe(0);
      }
    }
  });

  it('survives an odd frame and a zoom change', () => {
    const frame = { width: 1921, height: 1081 };
    const first = followCrop({
      target: { x: 1900, y: 1000 },
      prev: null,
      dtMs: 0,
      zoom: 1.5,
      frame,
    });
    const next = followCrop({
      target: { x: 1900, y: 1000 },
      prev: first,
      dtMs: 33,
      zoom: 3,
      frame,
    });
    expect(next.width).toBe(followCropSize(frame, 3).width);
    expect(next.x + next.width).toBeLessThanOrEqual(frame.width);
  });
});

describe('mosaicLayout', () => {
  const LIMIT = { maxWidth: 3840, maxHeight: 2160, maxPixels: 3840 * 2160 };

  it('keeps virtual positions relative to the bounding box', () => {
    const layout = mosaicLayout(
      [
        { width: 1920, height: 1080, x: -1920, y: 0 },
        { width: 1920, height: 1080, x: 0, y: 0 },
      ],
      'virtual',
      LIMIT,
    );
    expect(layout.width).toBe(3840);
    expect(layout.height).toBe(1080);
    expect(layout.rects[0]).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(layout.rects[1]).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 });
  });

  it('arranges a grid and scales to the limit with even sides', () => {
    const layout = mosaicLayout(
      [
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
        { width: 1280, height: 720 },
      ],
      'grid',
      { maxWidth: 1920, maxHeight: 1080, maxPixels: 1920 * 1080 },
    );
    expect(layout.width).toBeLessThanOrEqual(1920);
    expect(layout.height).toBeLessThanOrEqual(1080);
    expect(layout.width * layout.height).toBeLessThanOrEqual(1920 * 1080);
    expect(layout.rects).toHaveLength(3);
    for (const rect of layout.rects) {
      for (const value of [rect.x, rect.y, rect.width, rect.height]) expect(value % 2).toBe(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('never upscales', () => {
    const layout = mosaicLayout([{ width: 640, height: 360 }], 'grid', LIMIT);
    expect(layout).toMatchObject({ width: 640, height: 360 });
  });
});

describe('cameraRect', () => {
  const OUT = { width: 1920, height: 1080 };

  it('is a square sized by the shorter side (s 14 %, m 20 %, l 28 %)', () => {
    const side = (size: 's' | 'm' | 'l') => cameraRect({ nx: 0.5, ny: 0.5 }, OUT, size).width;
    expect([side('s'), side('m'), side('l')]).toEqual([150, 216, 302]);
    const rect = cameraRect({ nx: 0.5, ny: 0.5 }, OUT, 'm');
    expect(rect.width).toBe(rect.height);
    expect(rect.x + rect.width / 2).toBe(960);
  });

  it('is sized by the shorter side of a portrait output too', () => {
    expect(cameraRect({ nx: 0.5, ny: 0.5 }, { width: 720, height: 1280 }, 'm').width).toBe(144);
  });

  it('stays inside the output with a margin and even alignment', () => {
    for (const nx of [-1, 0, 1, 2]) {
      for (const ny of [-1, 0, 1, 2]) {
        const rect = cameraRect({ nx, ny }, OUT, 'l');
        expect(rect.x).toBeGreaterThanOrEqual(20);
        expect(rect.y).toBeGreaterThanOrEqual(20);
        expect(rect.x + rect.width).toBeLessThanOrEqual(OUT.width - 20);
        expect(rect.y + rect.height).toBeLessThanOrEqual(OUT.height - 20);
        for (const value of [rect.x, rect.y, rect.width, rect.height]) expect(value % 2).toBe(0);
      }
    }
  });
});
