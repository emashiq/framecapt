import { describe, expect, it } from 'vitest';
import {
  displayForPoint,
  framePixelsToDip,
  globalDipToDisplayLocal,
  normalizeDragRect,
  overlayRectToFramePixels,
  rectCrossesDisplays,
  type DisplayGeom,
} from '../../src/shared/geometry';

function display(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  scaleFactor = 1,
  rotation = 0,
): DisplayGeom {
  return { id, bounds: { x, y, width, height }, scaleFactor, rotation };
}

/** Frame as Chromium usually delivers it: bounds * scale, rounded. */
function frameOf(d: DisplayGeom): { width: number; height: number } {
  return {
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
  };
}

describe('normalizeDragRect', () => {
  it('handles every drag direction with non-negative sizes', () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 };
    expect(normalizeDragRect({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected);
    expect(normalizeDragRect({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected);
    expect(normalizeDragRect({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected);
    expect(normalizeDragRect({ x: 10, y: 60 }, { x: 40, y: 20 })).toEqual(expected);
  });

  it('returns a zero-size rect for a click', () => {
    expect(normalizeDragRect({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});

describe('overlayRectToFramePixels', () => {
  it.each([1, 1.25, 1.5, 2])('maps an integer-pixel selection exactly at scale %s', (scale) => {
    const d = display('a', 0, 0, 1600, 900, scale);
    const frame = frameOf(d);
    // 100x60 physical pixels at physical (200, 140), expressed in DIP.
    const dip = { x: 200 / scale, y: 140 / scale, width: 100 / scale, height: 60 / scale };
    expect(overlayRectToFramePixels(dip, d, frame)).toEqual({
      ok: true,
      rect: { x: 200, y: 140, width: 100, height: 60 },
    });
  });

  it('rounds outward so no covered pixel is lost', () => {
    const d = display('a', 0, 0, 1000, 800, 1.5);
    const frame = frameOf(d); // 1500 x 1200
    const result = overlayRectToFramePixels({ x: 10.1, y: 10.1, width: 10, height: 10 }, d, frame);
    // 10.1 * 1.5 = 15.15 -> floor 15; 20.1 * 1.5 = 30.15 -> ceil 31.
    expect(result).toEqual({ ok: true, rect: { x: 15, y: 15, width: 16, height: 16 } });
  });

  it('is not fooled by float noise on exact edges', () => {
    const d = display('a', 0, 0, 1600, 900, 1.25);
    const frame = frameOf(d);
    // 0.8 * 1.25 is 1.0000000000000002 in floating point; it must stay 1, not grow to 2.
    const result = overlayRectToFramePixels({ x: 0.8, y: 0.8, width: 80, height: 80 }, d, frame);
    expect(result).toEqual({ ok: true, rect: { x: 1, y: 1, width: 100, height: 100 } });
  });

  it('uses the actual frame size, not bounds * scaleFactor', () => {
    // Bounds 2293 x 960 at 1.5 would be 3439.5 x 1440; Chromium delivered 3440 x 1440.
    const d = display('b', -2293, 0, 2293, 960, 1.5);
    const frame = { width: 3440, height: 1440 };
    const full = overlayRectToFramePixels({ x: 0, y: 0, width: 2293, height: 960 }, d, frame);
    expect(full).toEqual({ ok: true, rect: { x: 0, y: 0, width: 3440, height: 1440 } });

    // A frame that is NOT bounds * scale at all (scale 1, frame 2x): the ratio wins.
    const odd = display('c', 0, 0, 1000, 500, 1);
    const half = overlayRectToFramePixels({ x: 500, y: 250, width: 500, height: 250 }, odd, {
      width: 2000,
      height: 1000,
    });
    expect(half).toEqual({ ok: true, rect: { x: 1000, y: 500, width: 1000, height: 500 } });
  });

  it('clamps to the frame when the selection touches or passes the edges', () => {
    const d = display('a', 0, 0, 800, 600);
    const frame = frameOf(d);
    expect(overlayRectToFramePixels({ x: -20, y: -20, width: 100, height: 100 }, d, frame)).toEqual(
      {
        ok: true,
        rect: { x: 0, y: 0, width: 80, height: 80 },
      },
    );
    expect(overlayRectToFramePixels({ x: 700, y: 500, width: 500, height: 500 }, d, frame)).toEqual(
      {
        ok: true,
        rect: { x: 700, y: 500, width: 100, height: 100 },
      },
    );
    expect(overlayRectToFramePixels({ x: 0, y: 0, width: 800, height: 600 }, d, frame)).toEqual({
      ok: true,
      rect: { x: 0, y: 0, width: 800, height: 600 },
    });
  });

  it('rejects selections outside the display', () => {
    const d = display('a', 0, 0, 800, 600);
    const frame = frameOf(d);
    expect(overlayRectToFramePixels({ x: 900, y: 10, width: 50, height: 50 }, d, frame)).toEqual({
      ok: false,
      reason: 'outside',
    });
    expect(overlayRectToFramePixels({ x: -100, y: 10, width: 50, height: 50 }, d, frame)).toEqual({
      ok: false,
      reason: 'outside',
    });
  });

  it('rejects zero, negative and sub-2px selections', () => {
    const d = display('a', 0, 0, 800, 600);
    const frame = frameOf(d);
    for (const rect of [
      { x: 10, y: 10, width: 0, height: 50 },
      { x: 10, y: 10, width: 50, height: 0 },
      { x: 10, y: 10, width: -5, height: 50 },
      { x: 10, y: 10, width: 1, height: 50 },
      { x: 10, y: 10, width: 50, height: 1 },
    ]) {
      expect(overlayRectToFramePixels(rect, d, frame).ok).toBe(false);
    }
    expect(overlayRectToFramePixels({ x: 10, y: 10, width: 2, height: 2 }, d, frame).ok).toBe(true);
  });

  it('rejects non-finite input and unusable frames', () => {
    const d = display('a', 0, 0, 800, 600);
    const frame = frameOf(d);
    expect(
      overlayRectToFramePixels({ x: Number.NaN, y: 0, width: 10, height: 10 }, d, frame),
    ).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(
      overlayRectToFramePixels({ x: 0, y: 0, width: 10, height: 10 }, d, { width: 0, height: 0 }),
    ).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('is independent of the display origin (negative origins)', () => {
    // Overlay coordinates are local, so the same local selection yields the same pixels
    // wherever the display sits in the virtual desktop.
    const local = { x: 120, y: 80, width: 640, height: 360 };
    const a = display('a', 0, 0, 1920, 1080);
    const b = display('b', -1920, -300, 1920, 1080);
    const frame = frameOf(a);
    expect(overlayRectToFramePixels(local, a, frame)).toEqual(
      overlayRectToFramePixels(local, b, frame),
    );
  });

  it('handles rotated displays whose bounds and frame are both portrait', () => {
    // 90 degrees: Electron reports bounds already rotated (1080 x 1920 DIP).
    for (const rotation of [90, 270]) {
      const d = display('r', 2560, -200, 1080, 1920, 1.25, rotation);
      const frame = frameOf(d); // 1350 x 2400
      expect(frame).toEqual({ width: 1350, height: 2400 });
      expect(
        overlayRectToFramePixels({ x: 100, y: 200, width: 400, height: 800 }, d, frame),
      ).toEqual({ ok: true, rect: { x: 125, y: 250, width: 500, height: 1000 } });
    }
  });

  it('refuses a frame whose orientation disagrees with the display instead of mis-cropping', () => {
    const portrait = display('r', 0, 0, 1080, 1920, 1, 90);
    expect(
      overlayRectToFramePixels({ x: 0, y: 0, width: 500, height: 500 }, portrait, {
        width: 1920,
        height: 1080,
      }),
    ).toEqual({ ok: false, reason: 'orientation-mismatch' });
  });

  it('works for a mixed-DPI pair with independent ratios', () => {
    const left = display('l', 0, 0, 1920, 1080, 1);
    const right = display('r', 1920, 0, 1600, 900, 1.5); // 2400 x 1350
    const sel = { x: 100, y: 100, width: 800, height: 450 };
    expect(overlayRectToFramePixels(sel, left, frameOf(left))).toEqual({
      ok: true,
      rect: { x: 100, y: 100, width: 800, height: 450 },
    });
    expect(overlayRectToFramePixels(sel, right, frameOf(right))).toEqual({
      ok: true,
      rect: { x: 150, y: 150, width: 1200, height: 675 },
    });
  });
});

describe('framePixelsToDip', () => {
  it('inverts overlayRectToFramePixels for exact selections', () => {
    for (const scale of [1, 1.25, 1.5, 2]) {
      const d = display('a', -1920, -300, 1600, 900, scale);
      const frame = frameOf(d);
      const px = { x: 300, y: 200, width: 400, height: 250 };
      const dip = framePixelsToDip(px, d, frame);
      const back = overlayRectToFramePixels(dip, d, frame);
      expect(back).toEqual({ ok: true, rect: px });
    }
  });

  it('uses the frame ratio, not the scale factor', () => {
    const d = display('b', 0, 0, 2293, 960, 1.5);
    const dip = framePixelsToDip({ x: 0, y: 0, width: 3440, height: 1440 }, d, {
      width: 3440,
      height: 1440,
    });
    expect(dip.width).toBeCloseTo(2293, 6);
    expect(dip.height).toBeCloseTo(960, 6);
  });

  it('returns an empty rect for unusable input', () => {
    const d = display('a', 0, 0, 100, 100);
    expect(
      framePixelsToDip({ x: 1, y: 1, width: 1, height: 1 }, d, { width: 0, height: 0 }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('globalDipToDisplayLocal / displayForPoint', () => {
  const left = display('left', -1920, -300, 1920, 1080);
  const primary = display('primary', 0, 0, 2560, 1440);
  const right = display('right', 2560, 100, 1920, 1080, 1.5);
  const all = [left, primary, right];

  it('converts with negative origins', () => {
    expect(globalDipToDisplayLocal({ x: -1900, y: -250 }, left)).toEqual({ x: 20, y: 50 });
    expect(globalDipToDisplayLocal({ x: 2600, y: 150 }, right)).toEqual({ x: 40, y: 50 });
  });

  it('finds the display containing a point', () => {
    expect(displayForPoint({ x: -1, y: -299 }, all)?.id).toBe('left');
    expect(displayForPoint({ x: 10, y: 10 }, all)?.id).toBe('primary');
    expect(displayForPoint({ x: 3000, y: 500 }, all)?.id).toBe('right');
  });

  it('treats the shared edge as belonging to the right/lower display', () => {
    expect(displayForPoint({ x: 0, y: 10 }, all)?.id).toBe('primary');
    expect(displayForPoint({ x: -1, y: 10 }, all)?.id).toBe('left');
    expect(displayForPoint({ x: 2560, y: 200 }, all)?.id).toBe('right');
  });

  it('returns undefined in dead space', () => {
    expect(displayForPoint({ x: -1900, y: 800 }, all)).toBeUndefined();
    expect(displayForPoint({ x: 9999, y: 0 }, all)).toBeUndefined();
  });
});

describe('rectCrossesDisplays', () => {
  const left = display('left', -1920, -300, 1920, 1080);
  const primary = display('primary', 0, 0, 2560, 1440);
  const all = [left, primary];

  it('is false for a rect inside one display or touching an edge only', () => {
    expect(rectCrossesDisplays({ x: 100, y: 100, width: 500, height: 500 }, all)).toBe(false);
    expect(rectCrossesDisplays({ x: -500, y: 0, width: 500, height: 100 }, all)).toBe(false);
    expect(rectCrossesDisplays({ x: -100, y: 0, width: 100, height: 100 }, all)).toBe(false);
  });

  it('is true when a rect overlaps two displays with positive area', () => {
    expect(rectCrossesDisplays({ x: -100, y: 0, width: 200, height: 100 }, all)).toBe(true);
  });

  it('ignores dead space and empty rects', () => {
    expect(rectCrossesDisplays({ x: -1000, y: 900, width: 2000, height: 100 }, all)).toBe(false);
    expect(rectCrossesDisplays({ x: -100, y: 0, width: 0, height: 100 }, all)).toBe(false);
  });
});
