import type { Point, Size } from './geometry';
import type { Rect } from './rect';

export type HandleId = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export const HANDLE_IDS: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function clampPoint(point: Point, size: Size): Point {
  return {
    x: Math.min(Math.max(point.x, 0), size.width),
    y: Math.min(Math.max(point.y, 0), size.height),
  };
}

/**
 * Moves the edges named by `handle` to `point` (already clamped to the overlay). Dragging an edge
 * past the opposite one flips the rectangle instead of producing a negative size.
 */
export function resizeRect(rect: Rect, handle: HandleId, point: Point): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes('w')) left = point.x;
  if (handle.includes('e')) right = point.x;
  if (handle.includes('n')) top = point.y;
  if (handle.includes('s')) bottom = point.y;
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  };
}

/** Translates a rect by (dx, dy) and keeps it fully inside the overlay. */
export function nudgeRect(rect: Rect, dx: number, dy: number, size: Size): Rect {
  const x = Math.min(Math.max(rect.x + dx, 0), Math.max(0, size.width - rect.width));
  const y = Math.min(Math.max(rect.y + dy, 0), Math.max(0, size.height - rect.height));
  return { ...rect, x, y };
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Where to put the floating action bar: below the selection when there is room, else above it,
 * else inside its bottom edge. Result is a top-left position clamped horizontally to the overlay.
 */
export function placeActionBar(
  rect: Rect,
  bar: Size,
  overlay: Size,
  gap = 10,
): { x: number; y: number } {
  const right = rect.x + rect.width;
  const x = Math.min(Math.max(right - bar.width, 8), Math.max(8, overlay.width - bar.width - 8));
  const below = rect.y + rect.height + gap;
  if (below + bar.height <= overlay.height - 8) return { x, y: below };
  const above = rect.y - gap - bar.height;
  if (above >= 8) return { x, y: above };
  return { x, y: Math.max(8, rect.y + rect.height - bar.height - gap) };
}
