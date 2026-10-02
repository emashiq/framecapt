import type { Rect } from './rect';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * What the transforms need to know about a display. `bounds` are in DIP (display-independent
 * pixels) in virtual-desktop coordinates, already in the display's current (rotated) orientation,
 * and x/y may be negative. `rotation` is informational: the frame ratio below already covers it.
 */
export interface DisplayGeom {
  id: string;
  bounds: Rect;
  scaleFactor: number;
  rotation: number;
}

/** Tolerance against float noise (1.25 * 1.6 !== 2) before rounding outward. */
const EPSILON = 1e-6;

/** Smallest selection (in frame pixels) that is accepted. */
export const MIN_SELECTION_PX = 2;

/** Rect spanned by two corner points, in any drag direction. Width and height are never negative. */
export function normalizeDragRect(p1: Point, p2: Point): Rect {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x),
    height: Math.abs(p2.y - p1.y),
  };
}

/** Converts a point in virtual-desktop DIP to coordinates local to `display` (origin top-left). */
export function globalDipToDisplayLocal(point: Point, display: DisplayGeom): Point {
  return { x: point.x - display.bounds.x, y: point.y - display.bounds.y };
}

function containsPoint(bounds: Rect, point: Point): boolean {
  // Half-open: a point on the shared edge of two side-by-side displays belongs to the right one.
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

/** The display containing a global DIP point, or undefined when it lies in no display. */
export function displayForPoint<D extends DisplayGeom>(
  point: Point,
  displays: readonly D[],
): D | undefined {
  return displays.find((display) => containsPoint(display.bounds, point));
}

/** True when a rectangle with positive area overlaps more than one display. */
export function rectCrossesDisplays(rect: Rect, displays: readonly DisplayGeom[]): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  let overlapping = 0;
  for (const { bounds } of displays) {
    const overlapW =
      Math.min(rect.x + rect.width, bounds.x + bounds.width) - Math.max(rect.x, bounds.x);
    const overlapH =
      Math.min(rect.y + rect.height, bounds.y + bounds.height) - Math.max(rect.y, bounds.y);
    if (overlapW > 0 && overlapH > 0) overlapping += 1;
  }
  return overlapping > 1;
}

export type FrameRectResult =
  | { ok: true; rect: Rect }
  | {
      ok: false;
      reason: 'invalid-input' | 'orientation-mismatch' | 'outside' | 'too-small';
    };

function isFiniteRect(rect: Rect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
}

/**
 * The scale from overlay DIP to captured-frame pixels, from the ACTUAL frame size. Chromium does
 * not always deliver exactly bounds * scaleFactor (rounding, rotated displays, fractional scale),
 * so `scaleFactor` is deliberately not used. Returns null for unusable input, or when the frame
 * orientation disagrees with the display's (a landscape frame for a portrait display), where
 * cropping would silently pick the wrong pixels.
 */
function frameScale(
  display: DisplayGeom,
  frame: Size,
):
  | { x: number; y: number; reason?: undefined }
  | { reason: 'invalid-input' | 'orientation-mismatch' } {
  const { width: bw, height: bh } = display.bounds;
  if (!(bw > 0 && bh > 0 && frame.width > 0 && frame.height > 0))
    return { reason: 'invalid-input' };
  const boundsLandscape = bw >= bh;
  const frameLandscape = frame.width >= frame.height;
  const square = (w: number, h: number): boolean => Math.abs(w - h) / Math.max(w, h) < 0.02;
  if (boundsLandscape !== frameLandscape && !square(bw, bh) && !square(frame.width, frame.height)) {
    return { reason: 'orientation-mismatch' };
  }
  return { x: frame.width / bw, y: frame.height / bh };
}

/**
 * Maps a selection made in a display's overlay (local DIP, origin top-left of the overlay) to an
 * integer pixel rectangle of the captured frame. Edges are rounded outward (the selection never
 * loses a pixel the user covered), then clamped to the frame. Selections under 2x2 pixels are
 * rejected.
 */
export function overlayRectToFramePixels(
  localDipRect: Rect,
  display: DisplayGeom,
  frameSize: Size,
): FrameRectResult {
  if (!isFiniteRect(localDipRect)) return { ok: false, reason: 'invalid-input' };
  const scale = frameScale(display, frameSize);
  if (scale.reason) return { ok: false, reason: scale.reason };

  const left = Math.floor(localDipRect.x * scale.x + EPSILON);
  const top = Math.floor(localDipRect.y * scale.y + EPSILON);
  const right = Math.ceil((localDipRect.x + localDipRect.width) * scale.x - EPSILON);
  const bottom = Math.ceil((localDipRect.y + localDipRect.height) * scale.y - EPSILON);

  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(frameSize.width, right);
  const y1 = Math.min(frameSize.height, bottom);
  if (x1 <= x0 || y1 <= y0) return { ok: false, reason: 'outside' };

  const width = x1 - x0;
  const height = y1 - y0;
  if (width < MIN_SELECTION_PX || height < MIN_SELECTION_PX)
    return { ok: false, reason: 'too-small' };
  return { ok: true, rect: { x: x0, y: y0, width, height } };
}

/** Inverse of {@link overlayRectToFramePixels}: frame pixels back to local DIP of the overlay. */
export function framePixelsToDip(pixelRect: Rect, display: DisplayGeom, frameSize: Size): Rect {
  const scale = frameScale(display, frameSize);
  if (scale.reason) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: pixelRect.x / scale.x,
    y: pixelRect.y / scale.y,
    width: pixelRect.width / scale.x,
    height: pixelRect.height / scale.y,
  };
}
