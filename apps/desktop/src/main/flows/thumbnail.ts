import { nativeImage } from 'electron';
import { drawRing, ringGeometry } from '../../shared/flow';
import { MAX_THUMBNAIL_WIDTH } from '../../shared/history-ipc';

/**
 * The History thumbnail of a guide: its first step reduced to at most 480 px wide with the pointer
 * ring burned in (only in this small copy, never in the stored step). Undefined when the image
 * cannot be decoded.
 */
export function guideThumbnail(
  png: Uint8Array,
  cursor: { x: number; y: number } | null,
  size: { width: number; height: number },
): Uint8Array | undefined {
  const image = nativeImage.createFromBuffer(Buffer.from(png));
  if (image.isEmpty() || size.width < 1) return undefined;
  const width = Math.min(MAX_THUMBNAIL_WIDTH, size.width);
  const small = width === size.width ? image : image.resize({ width, quality: 'good' });
  if (!cursor) return small.toPNG();
  const actual = small.getSize();
  const scale = actual.width / size.width;
  const bitmap = small.toBitmap();
  const full = ringGeometry(size.width);
  drawRing(
    bitmap,
    actual,
    { x: cursor.x * scale, y: cursor.y * scale },
    {
      radius: Math.max(6, Math.round(full.radius * scale)),
      stroke: Math.max(2, Math.round(full.stroke * scale * 1.5)),
    },
  );
  return nativeImage.createFromBitmap(bitmap, { ...actual, scaleFactor: 1 }).toPNG();
}
