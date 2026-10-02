/** JPEG quality used for exports. */
export const JPEG_QUALITY = 0.92;

/**
 * Encodes PNG bytes as JPEG. JPEG has no alpha, so the image is flattened onto white first.
 * Phase 04's editor passes its flattened canvas through the same path.
 */
export async function pngToJpeg(png: ArrayBuffer): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create a 2D canvas context.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return await blob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}
