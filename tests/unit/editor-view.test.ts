import { describe, expect, it } from 'vitest';
import {
  centerView,
  clampPan,
  clampZoom,
  cssScale,
  fitView,
  imageToScreen,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToImage,
  stepZoom,
  zoomAt,
  type View,
} from '../../src/renderer/editor/view';

const CASES: { zoom: number; panX: number; panY: number; dpr: number }[] = [
  { zoom: 1, panX: 0, panY: 0, dpr: 1 },
  { zoom: 1, panX: 40, panY: 30, dpr: 1.5 },
  { zoom: 0.25, panX: -120, panY: 55.5, dpr: 2 },
  { zoom: 8, panX: -3000, panY: -1200, dpr: 1.25 },
  { zoom: 0.1, panX: 300, panY: 200, dpr: 1 },
];

describe('screenToImage', () => {
  it('maps the pan origin to the image origin', () => {
    for (const { dpr, ...view } of CASES) {
      expect(screenToImage(view, dpr, { x: view.panX, y: view.panY })).toEqual({ x: 0, y: 0 });
    }
  });

  it('is the exact inverse of imageToScreen for every zoom, pan and DPR', () => {
    for (const { dpr, ...view } of CASES) {
      for (const point of [
        { x: 0, y: 0 },
        { x: 123.5, y: 77.25 },
        { x: 3439, y: 1439 },
      ]) {
        const back = screenToImage(view, dpr, imageToScreen(view, dpr, point));
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    }
  });

  it('zoom is device pixels per image pixel: 100% at DPR 1.5 is 2/3 CSS px per image px', () => {
    const view: View = { zoom: 1, panX: 0, panY: 0 };
    expect(cssScale(view, 1.5)).toBeCloseTo(2 / 3, 12);
    // 300 CSS px right of the origin is 450 image px.
    expect(screenToImage(view, 1.5, { x: 300, y: 0 }).x).toBeCloseTo(450, 9);
    // At 200% on a DPR 2 screen, one image pixel is one CSS pixel.
    expect(screenToImage({ zoom: 2, panX: 10, panY: 10 }, 2, { x: 110, y: 60 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  it('does not depend on the DPR when the CSS scale is the same', () => {
    const a = screenToImage({ zoom: 1, panX: 5, panY: 5 }, 1, { x: 105, y: 55 });
    const b = screenToImage({ zoom: 2, panX: 5, panY: 5 }, 2, { x: 105, y: 55 });
    expect(a).toEqual(b);
  });
});

describe('zoomAt', () => {
  it('keeps the image point under the cursor fixed', () => {
    for (const { dpr, ...view } of CASES) {
      const anchor = { x: 412, y: 233 };
      const before = screenToImage(view, dpr, anchor);
      const next = zoomAt(view, dpr, view.zoom * 1.7, anchor);
      const after = screenToImage(next, dpr, anchor);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('clamps to 10% .. 800%', () => {
    const view: View = { zoom: 1, panX: 0, panY: 0 };
    expect(zoomAt(view, 1, 99, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(view, 1, 0.001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM)).toBe(8);
    expect(clampZoom(MIN_ZOOM)).toBe(0.1);
  });

  it('steps snap to 100% when close', () => {
    expect(stepZoom(0.8, 1)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
  });
});

describe('fit and clamp', () => {
  it('fits a large image with padding, centered, and never above 100%', () => {
    const view = fitView({ width: 1000, height: 600 }, { width: 3440, height: 1440 }, 1);
    expect(view.zoom).toBeCloseTo(920 / 3440, 6);
    const topLeft = imageToScreen(view, 1, { x: 0, y: 0 });
    const bottomRight = imageToScreen(view, 1, { x: 3440, y: 1440 });
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(500, 6);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(300, 6);
    expect(fitView({ width: 1000, height: 600 }, { width: 100, height: 50 }, 1).zoom).toBe(1);
  });

  it('fit accounts for the DPR', () => {
    const view = fitView({ width: 1000, height: 600 }, { width: 3440, height: 1440 }, 2);
    expect(view.zoom).toBeCloseTo((920 * 2) / 3440, 6);
  });

  it('keeps part of the image visible and centers a small one', () => {
    const stage = { width: 800, height: 600 };
    const image = { width: 2000, height: 1000 };
    const far = clampPan({ zoom: 1, panX: -99999, panY: 99999 }, stage, image, 1);
    expect(far.panX).toBe(80 - 2000);
    expect(far.panY).toBe(600 - 80);
    const small = clampPan(
      { zoom: 1, panX: 500, panY: 500 },
      stage,
      { width: 100, height: 100 },
      1,
    );
    expect(small).toEqual(centerView(stage, { width: 100, height: 100 }, 1, 1));
  });
});
