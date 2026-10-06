import type { CalloutAnnotation, Point, Rect } from './types';

export interface CalloutTail {
  /** The two corners of the tail's base, on the bubble's edge. */
  a: Point;
  b: Point;
  tip: Point;
}

export const DEFAULT_CALLOUT_RADIUS = 10;

/**
 * The tail of a speech bubble: a triangle from the edge of `rect` nearest to `tail` to `tail`
 * itself. Null when the tail point is inside the bubble (no tail is drawn).
 */
export function calloutTail(
  rect: Rect,
  tail: Point,
  radius = DEFAULT_CALLOUT_RADIUS,
): CalloutTail | null {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const overX = tail.x < rect.x ? rect.x - tail.x : tail.x > right ? tail.x - right : 0;
  const overY = tail.y < rect.y ? rect.y - tail.y : tail.y > bottom ? tail.y - bottom : 0;
  if (overX === 0 && overY === 0) return null;
  const half = Math.min(18, Math.max(6, Math.min(rect.width, rect.height) * 0.2));
  const place = (start: number, length: number, target: number): number => {
    const lo = start + radius + half;
    const hi = start + length - radius - half;
    return lo > hi ? start + length / 2 : Math.min(hi, Math.max(lo, target));
  };
  if (overY >= overX) {
    const x = place(rect.x, rect.width, tail.x);
    const y = tail.y < rect.y ? rect.y : bottom;
    return { a: { x: x - half, y }, b: { x: x + half, y }, tip: { ...tail } };
  }
  const y = place(rect.y, rect.height, tail.y);
  const x = tail.x < rect.x ? rect.x : right;
  return { a: { x, y: y - half }, b: { x, y: y + half }, tip: { ...tail } };
}

/** The default tail point of a new bubble: below its middle. */
export function defaultTail(rect: Rect): Point {
  return {
    x: rect.x + rect.width * 0.3,
    y: rect.y + rect.height + Math.max(18, rect.height * 0.45),
  };
}

export function calloutRadius(annotation: Pick<CalloutAnnotation, 'radius'>): number {
  return annotation.radius ?? DEFAULT_CALLOUT_RADIUS;
}
