import type { PixelRect } from '../../../shared/video-edit';

/** Pure geometry of moving and resizing a box on the preview. Everything is in source pixels. */

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

export const RESIZE_HANDLES: readonly Exclude<Handle, 'move'>[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

export interface Bounds {
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Where each handle sits on a rect. */
export function handlePosition(
  rect: PixelRect,
  handle: Exclude<Handle, 'move'>,
): { x: number; y: number } {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  switch (handle) {
    case 'nw':
      return { x: left, y: top };
    case 'n':
      return { x: centerX, y: top };
    case 'ne':
      return { x: right, y: top };
    case 'e':
      return { x: right, y: centerY };
    case 'se':
      return { x: right, y: bottom };
    case 's':
      return { x: centerX, y: bottom };
    case 'sw':
      return { x: left, y: bottom };
    case 'w':
      return { x: left, y: centerY };
  }
}

/** The handle (within `reach` source pixels) or `move` (inside the rect) under a point, else null. */
export function hitHandle(
  point: { x: number; y: number },
  rect: PixelRect,
  reach: number,
): Handle | null {
  let best: Handle | null = null;
  let bestDistance = reach;
  for (const handle of RESIZE_HANDLES) {
    const at = handlePosition(rect, handle);
    const distance = Math.max(Math.abs(at.x - point.x), Math.abs(at.y - point.y));
    if (distance <= bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  }
  if (best) return best;
  const inside =
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
  return inside ? 'move' : null;
}

export function cursorFor(handle: Handle | null): string {
  switch (handle) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'move':
      return 'move';
    default:
      return 'default';
  }
}

/**
 * The rect after dragging `handle` by (dx, dy) from `start`: a move keeps the size and stays inside
 * the bounds; a resize moves the edges the handle owns, keeps at least `min` pixels and stays
 * inside the bounds. With `aspect` (width / height) a resize keeps that ratio.
 */
export function dragRect(
  start: PixelRect,
  handle: Handle,
  dx: number,
  dy: number,
  bounds: Bounds,
  min: number,
  aspect?: number,
): PixelRect {
  if (handle === 'move') {
    return {
      ...start,
      x: Math.round(clamp(start.x + dx, 0, bounds.width - start.width)),
      y: Math.round(clamp(start.y + dy, 0, bounds.height - start.height)),
    };
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - min);
  if (handle.includes('e')) right = clamp(right + dx, left + min, bounds.width);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - min);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min, bounds.height);
  if (aspect !== undefined && aspect > 0) {
    // Follow the larger change; grow away from the opposite edge/corner, then pull back inside.
    const widthFromHeight = (bottom - top) * aspect;
    const horizontalOnly = handle === 'e' || handle === 'w';
    const verticalOnly = handle === 'n' || handle === 's';
    let width = right - left;
    let height = bottom - top;
    if (
      horizontalOnly ||
      (!verticalOnly && Math.abs(width - start.width) >= Math.abs(height - start.height))
    ) {
      height = width / aspect;
    } else {
      width = widthFromHeight;
    }
    if (handle.includes('w')) left = right - width;
    else right = left + width;
    if (handle.includes('n')) top = bottom - height;
    else bottom = top + height;
    if (left < 0 || top < 0 || right > bounds.width || bottom > bounds.height) return start;
  }
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

/** A rect between two points (any corner order), inside the bounds, at least `min` in both sizes. */
export function rectFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bounds: Bounds,
  min: number,
): PixelRect {
  const left = clamp(Math.min(a.x, b.x), 0, bounds.width - min);
  const top = clamp(Math.min(a.y, b.y), 0, bounds.height - min);
  const right = clamp(Math.max(a.x, b.x), left + min, bounds.width);
  const bottom = clamp(Math.max(a.y, b.y), top + min, bounds.height);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

/** A rect of a default size centred on a point (a click without a drag), inside the bounds. */
export function rectAround(
  center: { x: number; y: number },
  size: { width: number; height: number },
  bounds: Bounds,
): PixelRect {
  const width = Math.min(size.width, bounds.width);
  const height = Math.min(size.height, bounds.height);
  return {
    x: Math.round(clamp(center.x - width / 2, 0, bounds.width - width)),
    y: Math.round(clamp(center.y - height / 2, 0, bounds.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export type AspectId = 'free' | '16:9' | '9:16' | '1:1' | '4:3';
export const ASPECTS: readonly { id: AspectId; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
];

/** The largest rect of a ratio inside `area`, centred on it. */
export function fitAspect(ratio: number, area: PixelRect): PixelRect {
  let width = area.width;
  let height = Math.round(width / ratio);
  if (height > area.height) {
    height = area.height;
    width = Math.round(height * ratio);
  }
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}
