import { describe, expect, it } from 'vitest';
import { checkPixelRect } from '../../src/shared/rect';

const display = { width: 2560, height: 1440 };

describe('checkPixelRect', () => {
  it('accepts a rect inside the display unchanged', () => {
    expect(checkPixelRect({ x: 100, y: 100, width: 1280, height: 720 }, display)).toEqual({
      ok: true,
      rect: { x: 100, y: 100, width: 1280, height: 720 },
    });
  });

  it('accepts a rect that exactly fills the display', () => {
    expect(checkPixelRect({ x: 0, y: 0, ...display }, display).ok).toBe(true);
  });

  it('rejects non-integers, non-finite values and non-positive sizes', () => {
    expect(checkPixelRect({ x: 0.5, y: 0, width: 10, height: 10 }, display).ok).toBe(false);
    expect(checkPixelRect({ x: 0, y: 0, width: Number.NaN, height: 10 }, display).ok).toBe(false);
    expect(checkPixelRect({ x: 0, y: 0, width: Infinity, height: 10 }, display).ok).toBe(false);
    expect(checkPixelRect({ x: 0, y: 0, width: 0, height: 10 }, display).ok).toBe(false);
    expect(checkPixelRect({ x: 0, y: 0, width: 10, height: -5 }, display).ok).toBe(false);
  });

  it('rejects rects that stick out unless clamping is requested', () => {
    expect(checkPixelRect({ x: 2000, y: 0, width: 1000, height: 100 }, display).ok).toBe(false);
    expect(checkPixelRect({ x: -10, y: 0, width: 100, height: 100 }, display).ok).toBe(false);
    expect(
      checkPixelRect({ x: 2000, y: 0, width: 1000, height: 100 }, display, { clamp: true }),
    ).toEqual({ ok: true, rect: { x: 2000, y: 0, width: 560, height: 100 } });
    expect(
      checkPixelRect({ x: -10, y: -20, width: 100, height: 100 }, display, { clamp: true }),
    ).toEqual({ ok: true, rect: { x: 0, y: 0, width: 90, height: 80 } });
  });

  it('rejects a rect entirely outside even with clamping', () => {
    const outside = { x: 3000, y: 0, width: 100, height: 100 };
    expect(checkPixelRect(outside, display, { clamp: true }).ok).toBe(false);
    const before = { x: -500, y: 0, width: 100, height: 100 };
    expect(checkPixelRect(before, display, { clamp: true }).ok).toBe(false);
  });

  it('aligns down to an even grid for video crops', () => {
    expect(
      checkPixelRect({ x: 101, y: 33, width: 1281, height: 721 }, display, { align: 2 }),
    ).toEqual({ ok: true, rect: { x: 100, y: 32, width: 1280, height: 720 } });
    expect(checkPixelRect({ x: 0, y: 0, width: 1, height: 100 }, display, { align: 2 }).ok).toBe(
      false,
    );
  });
});
