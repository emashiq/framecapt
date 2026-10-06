import { MAX_FRAME_DIMENSION } from './shots';

/** One screen's raw 4-bytes-per-pixel bitmap and where it sits on the virtual desktop, in physical pixels. */
export interface StitchPart {
  x: number;
  y: number;
  width: number;
  height: number;
  bitmap: Uint8Array;
}

export interface Stitched {
  width: number;
  height: number;
  /** Same pixel layout as the parts; gaps between screens are transparent (all zero). */
  bitmap: Uint8Array;
}

export class StitchError extends Error {
  constructor(
    readonly code: 'CAPTURE_FAILED' | 'TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'StitchError';
  }
}

/**
 * Places every part at its position, moved so the top-left-most pixel is (0, 0) (screens left of
 * or above the primary one have negative coordinates). Pure: no Electron, no image encoding.
 */
export function stitchBitmaps(parts: readonly StitchPart[]): Stitched {
  if (parts.length === 0) throw new StitchError('CAPTURE_FAILED', 'There is nothing to join.');
  for (const part of parts) {
    const valid =
      [part.x, part.y, part.width, part.height].every(Number.isInteger) &&
      part.width > 0 &&
      part.height > 0 &&
      part.bitmap.byteLength === part.width * part.height * 4;
    if (!valid) throw new StitchError('CAPTURE_FAILED', 'A screen image has an unexpected size.');
  }
  const left = Math.min(...parts.map((part) => part.x));
  const top = Math.min(...parts.map((part) => part.y));
  const width = Math.max(...parts.map((part) => part.x + part.width)) - left;
  const height = Math.max(...parts.map((part) => part.y + part.height)) - top;
  if (width > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION) {
    throw new StitchError(
      'TOO_LARGE',
      `Your screens together are ${width}×${height} px, more than the ${MAX_FRAME_DIMENSION} px limit. Capture them one at a time.`,
    );
  }
  const bitmap = new Uint8Array(width * height * 4);
  for (const part of parts) {
    const rowBytes = part.width * 4;
    for (let row = 0; row < part.height; row += 1) {
      const target = ((part.y - top + row) * width + (part.x - left)) * 4;
      bitmap.set(part.bitmap.subarray(row * rowBytes, (row + 1) * rowBytes), target);
    }
  }
  return { width, height, bitmap };
}
