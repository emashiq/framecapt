import type { Point, Rect } from './types';

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Moves `to` so that the segment from `from` is horizontal, vertical or diagonal (45 degrees). */
export function constrainTo45(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { ...to };
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

/** The rectangle spanned by `anchor` and `to`, forced to a square (the longer side wins). */
export function squareFromAnchor(anchor: Point, to: Point): Rect {
  const dx = to.x - anchor.x;
  const dy = to.y - anchor.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const corner = {
    x: anchor.x + (dx < 0 ? -side : side),
    y: anchor.y + (dy < 0 ? -side : side),
  };
  return rectFromPoints(anchor, corner);
}

export function normalizeRect(rect: Rect): Rect {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

export function expandRect(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
  };
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Distance from `p` to the segment a-b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from `p` to the outline of `rect` (0 when on the edge, positive inside and outside). */
export function distanceToRectOutline(p: Point, rect: Rect): number {
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  let best = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i] as Point;
    const b = corners[(i + 1) % 4] as Point;
    best = Math.min(best, distanceToSegment(p, a, b));
  }
  return best;
}

/** Integer rect clamped into [0, width] x [0, height]; null when nothing of it remains. */
export function clampRectToImage(
  rect: Rect,
  image: { width: number; height: number },
  minSize = 1,
): Rect | null {
  const n = normalizeRect(rect);
  const x0 = Math.max(0, Math.round(n.x));
  const y0 = Math.max(0, Math.round(n.y));
  const x1 = Math.min(image.width, Math.round(n.x + n.width));
  const y1 = Math.min(image.height, Math.round(n.y + n.height));
  if (x1 - x0 < minSize || y1 - y0 < minSize) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
