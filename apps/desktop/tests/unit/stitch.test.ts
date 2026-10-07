import { describe, expect, it } from 'vitest';
import { stitchBitmaps, StitchError, type StitchPart } from '../../src/shared/stitch';
import { MAX_FRAME_DIMENSION } from '../../src/shared/shots';

/** A part filled with one marker byte value in every channel. */
function part(x: number, y: number, width: number, height: number, fill: number): StitchPart {
  return { x, y, width, height, bitmap: new Uint8Array(width * height * 4).fill(fill) };
}

function pixel(result: { width: number; bitmap: Uint8Array }, x: number, y: number): number[] {
  const at = (y * result.width + x) * 4;
  return Array.from(result.bitmap.subarray(at, at + 4));
}

describe('stitchBitmaps', () => {
  it('places side by side screens and normalizes a negative origin', () => {
    const result = stitchBitmaps([part(0, 0, 2, 2, 1), part(-3, 0, 3, 2, 2)]);
    expect(result).toMatchObject({ width: 5, height: 2 });
    expect(pixel(result, 0, 0)).toEqual([2, 2, 2, 2]);
    expect(pixel(result, 2, 1)).toEqual([2, 2, 2, 2]);
    expect(pixel(result, 3, 0)).toEqual([1, 1, 1, 1]);
    expect(pixel(result, 4, 1)).toEqual([1, 1, 1, 1]);
  });

  it('handles screens of different heights and leaves the rest transparent', () => {
    const result = stitchBitmaps([part(0, 0, 2, 4, 1), part(2, 1, 2, 2, 2)]);
    expect(result).toMatchObject({ width: 4, height: 4 });
    expect(pixel(result, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(result, 3, 3)).toEqual([0, 0, 0, 0]);
    expect(pixel(result, 2, 1)).toEqual([2, 2, 2, 2]);
    expect(pixel(result, 1, 3)).toEqual([1, 1, 1, 1]);
  });

  it('leaves a gap between screens transparent', () => {
    const result = stitchBitmaps([part(0, 0, 1, 1, 1), part(3, 0, 1, 1, 2)]);
    expect(result.width).toBe(4);
    expect(pixel(result, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(result, 2, 0)).toEqual([0, 0, 0, 0]);
  });

  it('stacks a screen above the origin', () => {
    const result = stitchBitmaps([part(0, 0, 2, 2, 1), part(0, -2, 2, 2, 2)]);
    expect(result).toMatchObject({ width: 2, height: 4 });
    expect(pixel(result, 0, 0)).toEqual([2, 2, 2, 2]);
    expect(pixel(result, 0, 2)).toEqual([1, 1, 1, 1]);
  });

  it('rejects a result larger than the frame limit', () => {
    const wide = [part(0, 0, 1, 1, 1), part(MAX_FRAME_DIMENSION, 0, 1, 1, 2)];
    expect(() => stitchBitmaps(wide)).toThrow(StitchError);
    expect(() => stitchBitmaps(wide)).toThrow(/limit/);
  });

  it('rejects an empty list and a bitmap of the wrong size', () => {
    expect(() => stitchBitmaps([])).toThrow(StitchError);
    const bad = { ...part(0, 0, 2, 2, 1), bitmap: new Uint8Array(3) };
    expect(() => stitchBitmaps([bad])).toThrow(StitchError);
  });
});
