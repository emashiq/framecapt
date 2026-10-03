import { z } from 'zod';

/** What was captured. Stored with the session so the editor/history can say where it came from. */
export const ShotKindSchema = z.enum(['screen', 'window', 'region']);
export type ShotKind = z.infer<typeof ShotKindSchema>;

/** Renderer-visible session metadata. The original's file path stays in main. */
export const ShotSessionMetaSchema = z.object({
  id: z.string(),
  kind: ShotKindSchema,
  width: z.number().int(),
  height: z.number().int(),
  /** Epoch ms. */
  createdAt: z.number(),
});
export type ShotSessionMeta = z.infer<typeof ShotSessionMetaSchema>;

/** Largest single captured frame accepted from the worker (PNG bytes) and its largest side. */
export const MAX_FRAME_PNG_BYTES = 150 * 1024 * 1024;
export const MAX_FRAME_DIMENSION = 16384;
/** Largest exported image accepted from the renderer. */
export const MAX_EXPORT_BYTES = 200 * 1024 * 1024;
/** The worker gets this long to answer a frame request. */
export const WORKER_TIMEOUT_MS = 10_000;

export type ImageFormat = 'png' | 'jpeg';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

/** Identifies PNG/JPEG by magic bytes only; the file extension or MIME claim is never trusted. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'png';
  if (startsWith(bytes, JPEG_MAGIC)) return 'jpeg';
  return null;
}

export type ImageCheck = { ok: true } | { ok: false; reason: string };

/** Validates exported bytes against the format the renderer claims and the size cap. */
export function validateImageBytes(
  format: ImageFormat,
  bytes: Uint8Array,
  maxBytes: number = MAX_EXPORT_BYTES,
): ImageCheck {
  if (bytes.length === 0) return { ok: false, reason: 'The image is empty.' };
  if (bytes.length > maxBytes) return { ok: false, reason: 'The image is too large.' };
  if (detectImageFormat(bytes) !== format) {
    return { ok: false, reason: `The data is not a valid ${format.toUpperCase()} image.` };
  }
  return { ok: true };
}

const two = (value: number): string => String(value).padStart(2, '0');

/** "FrameCapt 2026-10-02 at 14.05.09.png" in local time (colons are not allowed in file names). */
export function defaultShotFileName(date: Date, format: ImageFormat): string {
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const time = `${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
  return `FrameCapt ${day} at ${time}.${format === 'png' ? 'png' : 'jpg'}`;
}

/**
 * True when a BGRA/RGBA bitmap is entirely black or fully transparent, sampled on a grid. Used to
 * recognise a window that returned an empty frame (minimized or protected).
 */
export function isBlankBitmap(bitmap: Uint8Array, width: number, height: number): boolean {
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return true;
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 64));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4;
      if (bitmap[i] !== 0 || bitmap[i + 1] !== 0 || bitmap[i + 2] !== 0) return false;
    }
  }
  return true;
}

/**
 * Width and height from the header of a PNG (IHDR) or JPEG (the first start-of-frame marker),
 * without decoding the picture. Null when the bytes are neither or the header is cut off.
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = detectImageFormat(bytes);
  if (format === 'png') {
    return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
  }
  if (format === 'jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      // Markers without a length: SOI, EOI, RSTn, TEM.
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        offset += 2;
        continue;
      }
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}
