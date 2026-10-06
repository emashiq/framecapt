import { MAX_FRAME_DIMENSION } from '../../shared/shots';
import type { EditorAsset } from './assets';

/** Browser-only picture decoding (kept apart from assets.ts, which also compiles without DOM types). */

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Any picture the browser can decode (PNG, JPEG, WebP, GIF's first frame, BMP) as PNG bytes. Used
 * for files, drops and pastes: main only ever receives PNG. Rejects pictures larger than a frame.
 */
export async function decodeToPng(
  blob: Blob,
): Promise<{ png: ArrayBuffer; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (width < 1 || height < 1 || width > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION) {
      throw new Error('The picture is too large.');
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create a 2D canvas context.');
    context.drawImage(bitmap, 0, 0);
    const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    return { png, width, height };
  } finally {
    bitmap.close();
  }
}

/** Decodes PNG bytes into an asset (its id is the hash of the bytes). */
export async function loadAsset(png: ArrayBuffer): Promise<EditorAsset> {
  const [id, image] = await Promise.all([
    sha256Hex(png),
    createImageBitmap(new Blob([png], { type: 'image/png' })),
  ]);
  return { id, png, image, width: image.width, height: image.height };
}
