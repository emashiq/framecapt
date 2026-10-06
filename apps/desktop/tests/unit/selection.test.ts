import { describe, expect, it } from 'vitest';
import {
  clampPoint,
  defaultSelection,
  growRect,
  nudgeRect,
  placeActionBar,
  pointInRect,
  resizeRect,
} from '../../src/shared/selection';

const size = { width: 1000, height: 600 };

describe('clampPoint', () => {
  it('keeps points inside the overlay', () => {
    expect(clampPoint({ x: -5, y: 700 }, size)).toEqual({ x: 0, y: 600 });
    expect(clampPoint({ x: 500, y: 300 }, size)).toEqual({ x: 500, y: 300 });
  });
});

describe('resizeRect', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it('moves only the edges named by the handle', () => {
    expect(resizeRect(rect, 'e', { x: 400, y: 999 })).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 100,
    });
    expect(resizeRect(rect, 'nw', { x: 50, y: 60 })).toEqual({
      x: 50,
      y: 60,
      width: 250,
      height: 140,
    });
    expect(resizeRect(rect, 's', { x: 0, y: 400 })).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 300,
    });
  });

  it('flips instead of going negative when dragged past the opposite edge', () => {
    expect(resizeRect(rect, 'e', { x: 50, y: 0 })).toEqual({
      x: 50,
      y: 100,
      width: 50,
      height: 100,
    });
    expect(resizeRect(rect, 'n', { x: 0, y: 250 })).toEqual({
      x: 100,
      y: 200,
      width: 200,
      height: 50,
    });
  });
});

describe('nudgeRect', () => {
  it('moves by the delta and stays inside the overlay', () => {
    const rect = { x: 10, y: 10, width: 100, height: 50 };
    expect(nudgeRect(rect, 1, 0, size)).toEqual({ x: 11, y: 10, width: 100, height: 50 });
    expect(nudgeRect(rect, -50, -50, size)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(nudgeRect(rect, 5000, 5000, size)).toEqual({ x: 900, y: 550, width: 100, height: 50 });
  });
});

describe('pointInRect', () => {
  it('includes the edges', () => {
    const rect = { x: 10, y: 10, width: 10, height: 10 };
    expect(pointInRect({ x: 10, y: 20 }, rect)).toBe(true);
    expect(pointInRect({ x: 21, y: 20 }, rect)).toBe(false);
  });
});

describe('placeActionBar', () => {
  const bar = { width: 268, height: 52 };

  it('goes below the selection, right-aligned, when there is room', () => {
    const pos = placeActionBar({ x: 100, y: 100, width: 500, height: 200 }, bar, size);
    expect(pos).toEqual({ x: 600 - 268, y: 310 });
  });

  it('goes above when the selection touches the bottom', () => {
    const pos = placeActionBar({ x: 100, y: 300, width: 500, height: 300 }, bar, size);
    expect(pos.y).toBe(300 - 10 - 52);
  });

  it('goes inside the bottom edge when neither side fits', () => {
    const pos = placeActionBar({ x: 100, y: 0, width: 500, height: 600 }, bar, size);
    expect(pos.y).toBe(600 - 52 - 10);
  });

  it('stays horizontally on screen for narrow selections near the left edge', () => {
    const pos = placeActionBar({ x: 0, y: 100, width: 50, height: 50 }, bar, size);
    expect(pos.x).toBe(8);
  });
});

describe('keyboard selection', () => {
  const display = { width: 1000, height: 600 };

  it('starts from a centered half-size selection', () => {
    expect(defaultSelection(display)).toEqual({ x: 250, y: 150, width: 500, height: 300 });
    expect(defaultSelection({ width: 3, height: 3 })).toMatchObject({ width: 2, height: 2 });
  });

  it('grows and shrinks from the bottom-right, clamped to the display', () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    expect(growRect(rect, 1, -1, display)).toEqual({ x: 100, y: 100, width: 201, height: 99 });
    expect(growRect(rect, -500, -500, display)).toEqual({ x: 100, y: 100, width: 1, height: 1 });
    expect(growRect(rect, 5000, 5000, display)).toEqual({
      x: 100,
      y: 100,
      width: 900,
      height: 500,
    });
  });
});
