import { CaptureError } from './errors';

/** A mock window that cannot be captured, to exercise the "minimized or protected" error path. */
export const SYNTHETIC_UNCAPTURABLE_SOURCE = 'window:1005:0';

/**
 * Generated frames for E2E builds ONLY (reached through a dynamic import guarded by
 * __FRAMECAPT_E2E__, and checked out of production bundles by scripts/check-no-mocks.mjs).
 *
 * Every pixel is a pure function of its position so tests can verify a crop exactly:
 *   R = floor(255 * x / (width - 1)),  G = floor(255 * y / (height - 1)),
 *   B = 200 on odd 64 px checker cells, else 60.
 */
export async function drawSyntheticFrame(
  sourceId: string,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  if (sourceId === SYNTHETIC_UNCAPTURABLE_SOURCE)
    throw new CaptureError('source-gone', 'Synthetic: window cannot be captured');
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D context for the synthetic frame');
  const image = context.createImageData(width, height);
  const data = image.data;
  const xDen = Math.max(1, width - 1);
  const yDen = Math.max(1, height - 1);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const green = Math.floor((255 * y) / yDen);
    for (let x = 0; x < width; x += 1) {
      data[offset] = Math.floor((255 * x) / xDen);
      data[offset + 1] = green;
      data[offset + 2] = ((x >> 6) + (y >> 6)) & 1 ? 200 : 60;
      data[offset + 3] = 255;
      offset += 4;
    }
  }
  context.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}
