import { describe, expect, it } from 'vitest';
import { bgraToRgba } from '../../src/shared/pixels';

describe('bgraToRgba', () => {
  it('swaps blue and red and keeps green and alpha', () => {
    // pixels as Electron's toBitmap() writes them: B, G, R, A
    const bgra = new Uint8Array([10, 20, 30, 255, 0, 0, 255, 255, 255, 0, 0, 128]);
    expect([...bgraToRgba(bgra.buffer)]).toEqual([30, 20, 10, 255, 255, 0, 0, 255, 0, 0, 255, 128]);
  });

  it('does not modify its input and handles a whole row', () => {
    const bgra = new Uint8Array(4 * 3440);
    for (let i = 0; i < bgra.length; i += 4) {
      bgra[i] = i & 0xff;
      bgra[i + 1] = (i >> 3) & 0xff;
      bgra[i + 2] = (i >> 5) & 0xff;
      bgra[i + 3] = 255;
    }
    const copy = bgra.slice();
    const rgba = bgraToRgba(bgra.buffer);
    expect(bgra).toEqual(copy);
    for (let i = 0; i < bgra.length; i += 4) {
      expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]).toEqual([
        copy[i + 2],
        copy[i + 1],
        copy[i],
        copy[i + 3],
      ]);
    }
  });
});
