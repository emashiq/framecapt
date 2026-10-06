import type { ArrowAnnotation, HeadStyle, Point } from './types';

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

/**
 * Triangle head at `to`, pointing away from `from`. A zero-length arrow collapses to its tip.
 * `refLength` is the length the head is sized against (the chord of a curved arrow).
 */
export function arrowGeometry(
  from: Point,
  to: Point,
  width: number,
  refLength?: number,
): ArrowGeometry {
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
  const headLength = arrowHeadLength(width, refLength ?? length);
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

export const DEFAULT_BEND = 0.28;

/** The control point of a curved arrow (a quadratic bezier), or null for a straight one. */
export function arrowControl(
  arrow: Pick<ArrowAnnotation, 'from' | 'to' | 'style' | 'bend'>,
): Point | null {
  if (arrow.style !== 'curved') return null;
  const dx = arrow.to.x - arrow.from.x;
  const dy = arrow.to.y - arrow.from.y;
  const bend = arrow.bend ?? DEFAULT_BEND;
  // The control point sits at twice the visual bow: the curve passes half way to it.
  return {
    x: (arrow.from.x + arrow.to.x) / 2 - dy * bend * 2,
    y: (arrow.from.y + arrow.to.y) / 2 + dx * bend * 2,
  };
}

/** The point at `t` (0..1) of the quadratic bezier from..to with control point `control`. */
export function quadPoint(from: Point, control: Point, to: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
  };
}

export interface HeadDraw {
  style: Exclude<HeadStyle, 'none'>;
  geometry: ArrowGeometry;
  /** Radius of a 'dot' head. */
  dotRadius: number;
}

export interface ArrowDraw {
  /** The shaft: a straight segment or a quadratic bezier. */
  from: Point;
  to: Point;
  control: Point | null;
  start: HeadDraw | null;
  end: HeadDraw | null;
}

function head(
  style: HeadStyle,
  tail: Point,
  tip: Point,
  width: number,
  chord: number,
): HeadDraw | null {
  if (style === 'none') return null;
  const geometry = arrowGeometry(tail, tip, width, chord);
  if (style === 'dot') {
    const dotRadius = Math.max(width * 1.7, 4);
    return { style, geometry: { ...geometry, shaftEnd: { ...tip }, headLength: 0 }, dotRadius };
  }
  if (style === 'open') {
    const long = arrowGeometry(tail, tip, width, chord);
    return { style, geometry: { ...long, shaftEnd: { ...tip } }, dotRadius: 0 };
  }
  return { style, geometry, dotRadius: 0 };
}

/**
 * Everything needed to draw (and measure) an arrow: its shaft trimmed to the heads, and a head at
 * each end that has one. A plain old arrow (no style fields) is a straight shaft with a triangle
 * at `to`.
 */
export function arrowDraw(arrow: ArrowAnnotation): ArrowDraw {
  const control = arrowControl(arrow);
  const chord = Math.hypot(arrow.to.x - arrow.from.x, arrow.to.y - arrow.from.y);
  const end = head(
    arrow.endHead ?? 'triangle',
    control ?? arrow.from,
    arrow.to,
    arrow.width,
    chord,
  );
  const start = head(
    arrow.startHead ?? 'none',
    control ?? arrow.to,
    arrow.from,
    arrow.width,
    chord,
  );
  return {
    from: start && start.geometry.headLength > 0 ? start.geometry.shaftEnd : arrow.from,
    to: end && end.geometry.headLength > 0 ? end.geometry.shaftEnd : arrow.to,
    control,
    start,
    end,
  };
}
