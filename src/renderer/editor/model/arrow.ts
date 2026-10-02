import type { Point } from './types';

export interface ArrowGeometry {
  /** Where the shaft stops (the middle of the head's base). */
  shaftEnd: Point;
  tip: Point;
  left: Point;
  right: Point;
  headLength: number;
}

const HEAD_ANGLE = (28 * Math.PI) / 180;

/** Head length for a stroke width, never shorter than 12 px and never longer than the arrow. */
export function arrowHeadLength(width: number, arrowLength: number): number {
  return Math.min(Math.max(12, width * 4.5), Math.max(arrowLength * 0.6, 0));
}

/** Triangle head at `to`, pointing away from `from`. A zero-length arrow collapses to its tip. */
export function arrowGeometry(from: Point, to: Point, width: number): ArrowGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return {
      shaftEnd: { ...to },
      tip: { ...to },
      left: { ...to },
      right: { ...to },
      headLength: 0,
    };
  }
  const ux = dx / length;
  const uy = dy / length;
  const headLength = arrowHeadLength(width, length);
  const back = { x: to.x - ux * headLength, y: to.y - uy * headLength };
  const halfWidth = Math.tan(HEAD_ANGLE) * headLength;
  const nx = -uy;
  const ny = ux;
  return {
    // A little inside the head so a thick shaft never pokes out of the triangle's sides.
    shaftEnd: { x: back.x + ux * headLength * 0.35, y: back.y + uy * headLength * 0.35 },
    tip: { ...to },
    left: { x: back.x + nx * halfWidth, y: back.y + ny * halfWidth },
    right: { x: back.x - nx * halfWidth, y: back.y - ny * halfWidth },
    headLength,
  };
}
