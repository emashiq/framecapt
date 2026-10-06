export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RectCheck = { ok: true; rect: Rect } | { ok: false; reason: string };

/**
 * Validates a pixel rectangle against a display of `bounds` pixels (origin 0,0). Requires finite
 * integers and a positive size. With `clamp` the rect is intersected with the bounds instead of
 * rejected when it sticks out. With `align` (e.g. 2 for 4:2:0 video) x/y/width/height are rounded
 * down to a multiple of `align`.
 */
export function checkPixelRect(
  rect: Rect,
  bounds: { width: number; height: number },
  options: { clamp?: boolean; align?: number } = {},
): RectCheck {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every((value) => Number.isFinite(value) && Number.isInteger(value))) {
    return { ok: false, reason: 'Region values must be whole numbers.' };
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return { ok: false, reason: 'Region width and height must be positive.' };
  }
  if (rect.x < 0 || rect.y < 0) {
    if (!options.clamp) return { ok: false, reason: 'Region starts outside the display.' };
  }

  let { x, y, width, height } = rect;
  if (options.clamp) {
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(bounds.width, x + width);
    const bottom = Math.min(bounds.height, y + height);
    x = left;
    y = top;
    width = right - left;
    height = bottom - top;
    if (width <= 0 || height <= 0) return { ok: false, reason: 'Region is outside the display.' };
  } else if (x + width > bounds.width || y + height > bounds.height) {
    return { ok: false, reason: 'Region extends past the display edge.' };
  }

  const align = options.align ?? 1;
  if (align > 1) {
    x -= x % align;
    y -= y % align;
    width -= width % align;
    height -= height % align;
    if (width <= 0 || height <= 0) return { ok: false, reason: 'Region is too small.' };
  }
  return { ok: true, rect: { x, y, width, height } };
}
