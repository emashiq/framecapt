import { z } from 'zod';
import { globalDipToDisplayLocal, type DisplayGeom, type Point, type Size } from './geometry';

/**
 * Step guides ("flow capture"): the on-disk format of `flow.json`, the names of the folders and
 * files, and the pure geometry the capture and the Flow view share. No Electron here.
 */

export const FLOW_VERSION = 1;
export const FLOW_FILE_NAME = 'flow.json';
/** Most steps one guide holds; the capture pauses itself at this number. */
export const MAX_FLOW_STEPS = 200;
export const MAX_CAPTION_LENGTH = 500;
export const MAX_TITLE_LENGTH = 120;
/** `step-01.png` ... `step-200.png`: the only image names a guide folder holds. */
export const STEP_FILE_PATTERN = /^step-\d{2,3}\.png$/;

export const stepFileName = (index: number): string =>
  `step-${String(index + 1).padStart(2, '0')}.png`;

export const FlowStepSchema = z.object({
  file: z.string().regex(STEP_FILE_PATTERN),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  /** The pointer in this image's pixels; null when it was not on this screen. */
  cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
  caption: z.string().max(MAX_CAPTION_LENGTH),
  /** When the step was captured (epoch ms). */
  at: z.number(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowFileSchema = z.object({
  version: z.literal(FLOW_VERSION),
  createdAt: z.number(),
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
  steps: z.array(FlowStepSchema).min(1).max(MAX_FLOW_STEPS),
});
export type FlowFile = z.infer<typeof FlowFileSchema>;

// --- folder names ---------------------------------------------------------------------------

const two = (value: number): string => String(value).padStart(2, '0');

/** "FrameCapt Steps 2026-10-07 at 14.05.09" in local time. */
export function flowFolderName(date: Date): string {
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const time = `${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
  return `FrameCapt Steps ${day} at ${time}`;
}

const FOLDER_PATTERN =
  /^FrameCapt Steps (\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})(?: \(\d+\))?$/;

export function isFlowFolderName(name: string): boolean {
  return FOLDER_PATTERN.test(name);
}

/** Local time from a folder name the app made; null for any other name. */
export function createdAtFromFlowFolder(name: string): number | null {
  const match = FOLDER_PATTERN.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** True when a folder holds nothing but `flow.json` and step images: the only kind FrameCapt trashes whole. */
export function isOnlyFlowFiles(names: readonly string[]): boolean {
  return names.every((name) => name === FLOW_FILE_NAME || STEP_FILE_PATTERN.test(name));
}

/** The media route of one step image (the protocol checks the guide and the index). `nonce`: lowercase letters and digits. */
export const flowStepUrl = (historyId: string, index: number, nonce: string): string =>
  `framecapt-media://flowstep/${historyId}/${index}/${nonce}`;

/** A title as a file name: no characters Windows forbids, no trailing dots or spaces, a sane length. */
export function safeFileStem(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  return cleaned === '' ? 'Step guide' : cleaned;
}

// --- pointer geometry -----------------------------------------------------------------------

/**
 * The pointer (global DIP) in the pixels of the frame grabbed from `display`. The scale is taken
 * from the real frame size (like `overlayRectToFramePixels`), not from `scaleFactor`. Null when
 * the pointer is outside the display or the input is unusable.
 */
export function cursorToFramePixels(point: Point, display: DisplayGeom, frame: Size): Point | null {
  const { width, height } = display.bounds;
  if (!(width > 0 && height > 0 && frame.width > 0 && frame.height > 0)) return null;
  const local = globalDipToDisplayLocal(point, display);
  if (local.x < 0 || local.y < 0 || local.x >= width || local.y >= height) return null;
  return {
    x: Math.round((local.x * frame.width) / width),
    y: Math.round((local.y * frame.height) / height),
  };
}

/** The ring around the pointer, scaled to the image so it reads the same on any screen. */
export function ringGeometry(imageWidth: number): { radius: number; stroke: number } {
  const unit = Math.max(1, imageWidth / 1280);
  return { radius: Math.round(26 * unit), stroke: Math.max(2, Math.round(3 * unit)) };
}

/** The accent of the app (indigo), used for the ring in the view, the exports and the thumbnail. */
export const RING_COLOR = { r: 99, g: 102, b: 241 } as const;

/**
 * Draws the pointer ring into a BGRA bitmap (what `nativeImage.toBitmap()` returns): a soft
 * accent fill, a white halo and the accent stroke. Pure, so it is tested without Electron.
 */
export function drawRing(
  bitmap: Uint8Array,
  size: Size,
  center: Point,
  ring: { radius: number; stroke: number },
): void {
  const { radius, stroke } = ring;
  const halo = Math.max(1, Math.round(stroke / 2));
  const outer = radius + stroke + halo;
  const x0 = Math.max(0, Math.floor(center.x - outer));
  const x1 = Math.min(size.width - 1, Math.ceil(center.x + outer));
  const y0 = Math.max(0, Math.floor(center.y - outer));
  const y1 = Math.min(size.height - 1, Math.ceil(center.y + outer));
  const blend = (offset: number, r: number, g: number, b: number, alpha: number): void => {
    const keep = 1 - alpha;
    bitmap[offset] = Math.round((bitmap[offset] ?? 0) * keep + b * alpha);
    bitmap[offset + 1] = Math.round((bitmap[offset + 1] ?? 0) * keep + g * alpha);
    bitmap[offset + 2] = Math.round((bitmap[offset + 2] ?? 0) * keep + r * alpha);
    bitmap[offset + 3] = 255;
  };
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const distance = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y);
      const offset = (y * size.width + x) * 4;
      if (distance <= radius) {
        blend(offset, RING_COLOR.r, RING_COLOR.g, RING_COLOR.b, 0.18);
      } else if (distance <= radius + stroke) {
        blend(offset, RING_COLOR.r, RING_COLOR.g, RING_COLOR.b, 1);
      } else if (distance <= outer) {
        blend(offset, 255, 255, 255, 0.9);
      }
    }
  }
}
