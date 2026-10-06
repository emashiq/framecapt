import { z } from 'zod';
import type { Rect } from './rect';

/** The webcam overlay: shape, size and (for window recordings) the corner it sits in. */
export const CAMERA_SHAPES = ['circle', 'rounded'] as const;
export const CAMERA_SIZES = ['s', 'm', 'l'] as const;
export const CAMERA_CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
export type CameraShape = (typeof CAMERA_SHAPES)[number];
export type CameraSize = (typeof CAMERA_SIZES)[number];
export type CameraCorner = (typeof CAMERA_CORNERS)[number];

export const CameraShapeSchema = z.enum(CAMERA_SHAPES);
export const CameraSizeSchema = z.enum(CAMERA_SIZES);
export const CameraCornerSchema = z.enum(CAMERA_CORNERS);

export const DEFAULT_CAMERA_STYLE: {
  shape: CameraShape;
  size: CameraSize;
  corner: CameraCorner;
} = { shape: 'circle', size: 'm', corner: 'br' };

/** Side of the camera bubble window, in DIP. */
export const CAMERA_WINDOW_DIP: Record<CameraSize, number> = { s: 160, m: 220, l: 300 };
/** Gap between the bubble and the edge of the area it starts in, in DIP. */
export const CAMERA_MARGIN_DIP = 24;

/** `camera:setStyle`: the bubble reports a change of its own style (any subset). */
export const CameraSetStyleRequestSchema = z
  .strictObject({
    size: CameraSizeSchema.optional(),
    shape: CameraShapeSchema.optional(),
    visible: z.boolean().optional(),
  })
  .refine((request) => Object.keys(request).length > 0, 'Nothing to change.');
export type CameraSetStyleRequest = z.infer<typeof CameraSetStyleRequestSchema>;

/** `camera:getStyle`: what the bubble shows. `deviceId` undefined = the default camera. */
export const CameraStyleStateSchema = z.strictObject({
  deviceId: z.string().max(256).optional(),
  shape: CameraShapeSchema,
  size: CameraSizeSchema,
});
export type CameraStyleState = z.infer<typeof CameraStyleStateSchema>;

/** The next size when the bubble's size button is pressed: S, M, L, S, ... */
export function nextCameraSize(size: CameraSize): CameraSize {
  const index = CAMERA_SIZES.indexOf(size);
  return CAMERA_SIZES[(index + 1) % CAMERA_SIZES.length] as CameraSize;
}

/** Center of a corner as a point of the output (0 or 1 on each axis); the compositor keeps it inside. */
export function cornerCenter(corner: CameraCorner): { nx: number; ny: number } {
  return { nx: corner.endsWith('r') ? 1 : 0, ny: corner.startsWith('b') ? 1 : 0 };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The bubble's center as a point of the captured area (0..1 each axis, clamped inside it). */
export function normalizedCenter(bubble: Rect, area: Rect): { nx: number; ny: number } {
  return {
    nx: clamp01((bubble.x + bubble.width / 2 - area.x) / area.width),
    ny: clamp01((bubble.y + bubble.height / 2 - area.y) / area.height),
  };
}

/** The quadrant of `area` (a display) that the bubble's center is in. */
export function cornerOfBubble(bubble: Rect, area: Rect): CameraCorner {
  const right = bubble.x + bubble.width / 2 >= area.x + area.width / 2;
  const bottom = bubble.y + bubble.height / 2 >= area.y + area.height / 2;
  return `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}` as CameraCorner;
}

/** A square of `side` in `corner` of `area`, `margin` away from its edges (never outside the area). */
export function cornerBounds(
  side: number,
  corner: CameraCorner,
  area: Rect,
  margin = CAMERA_MARGIN_DIP,
): Rect {
  const x = corner.endsWith('r') ? area.x + area.width - side - margin : area.x + margin;
  const y = corner.startsWith('b') ? area.y + area.height - side - margin : area.y + margin;
  return {
    x: Math.round(Math.max(area.x, x)),
    y: Math.round(Math.max(area.y, y)),
    width: side,
    height: side,
  };
}

/** `bounds` moved the shortest way to lie inside `area` (unchanged when the area is smaller). */
export function clampInto(bounds: Rect, area: Rect): Rect {
  if (bounds.width > area.width || bounds.height > area.height) return bounds;
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
  };
}
