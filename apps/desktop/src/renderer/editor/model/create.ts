import { defaultTail } from './callout';
import { constrainTo45, rectFromPoints, squareFromAnchor } from './geometry';
import { MAX_PEN_POINTS } from './commands';
import type {
  Annotation,
  ArrowStyle,
  BlurMode,
  DashStyle,
  FontFamilyId,
  HeadStyle,
  Point,
  Rect,
  Shadow,
  StampId,
  TextAlign,
} from './types';
import { DEFAULT_SPOTLIGHT_DIM, HIGHLIGHT_OPACITY } from './types';

/** What new annotations are made with: the editor's current "pen". */
export interface StyleDefaults {
  color: string;
  strokeWidth: number;
  fontSize: number;
  fontWeight: number;
  /** Fill of new shapes (null: none) and its opacity. */
  fill: string | null;
  fillOpacity: number;
  /** Opacity of a whole new element. */
  opacity: number;
  radius: number;
  shadow: Shadow | null;
  arrowStyle: ArrowStyle;
  startHead: HeadStyle;
  endHead: HeadStyle;
  dash: DashStyle;
  blurMode: BlurMode;
  blurAmount: number;
  /** The number the next step badge gets. */
  stepNumber: number;
  stamp: StampId;
  highlightMode: 'rect' | 'freehand';
  highlightColor: string;
  spotlightShape: 'rect' | 'ellipse';
  spotlightDim: number;
  magnifierZoom: number;
  family: FontFamilyId;
  italic: boolean;
  align: TextAlign;
  textBackground: string | null;
  outlineColor: string | null;
  outlineWidth: number;
  calloutColor: string;
  calloutTextColor: string;
}

export const DEFAULT_HIGHLIGHT_COLOR = '#FACC15';

/** Tools that make their element by dragging a box or a segment. */
export type DragTool =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'highlight'
  | 'blur'
  | 'redact'
  | 'spotlight'
  | 'magnifier'
  | 'ruler'
  | 'callout';

const shadowOf = (d: StyleDefaults): { shadow?: Shadow } => (d.shadow ? { shadow: d.shadow } : {});
const opacityOf = (d: StyleDefaults): { opacity?: number } =>
  d.opacity < 1 ? { opacity: d.opacity } : {};

/**
 * The element a drag from `start` to `point` makes right now (drawn live while dragging, added
 * when the pointer is released). Shift keeps a shape square/circular and a segment at 45 degrees.
 */
export function draftFor(
  tool: DragTool,
  id: string,
  start: Point,
  point: Point,
  shift: boolean,
  d: StyleDefaults,
): Annotation {
  const box: Rect = shift ? squareFromAnchor(start, point) : rectFromPoints(start, point);
  switch (tool) {
    case 'arrow':
      return {
        type: 'arrow',
        id,
        from: start,
        to: shift ? constrainTo45(start, point) : point,
        color: d.color,
        width: d.strokeWidth,
        ...(d.arrowStyle !== 'straight' && { style: d.arrowStyle }),
        ...(d.startHead !== 'none' && { startHead: d.startHead }),
        ...(d.endHead !== 'triangle' && { endHead: d.endHead }),
        ...opacityOf(d),
        ...shadowOf(d),
      };
    case 'line':
      return {
        type: 'line',
        id,
        from: start,
        to: shift ? constrainTo45(start, point) : point,
        color: d.color,
        width: d.strokeWidth,
        ...(d.dash !== 'solid' && { dash: d.dash }),
        ...opacityOf(d),
        ...shadowOf(d),
      };
    case 'ruler':
      return {
        type: 'ruler',
        id,
        from: start,
        to: shift ? constrainTo45(start, point) : point,
        color: d.color,
        width: Math.max(2, Math.round(d.strokeWidth * 0.7)),
      };
    case 'rect':
      return {
        type: 'rect',
        id,
        rect: box,
        color: d.color,
        width: d.strokeWidth,
        ...(d.fill !== null && { fill: d.fill, fillOpacity: d.fillOpacity }),
        ...(d.radius > 0 && { radius: d.radius }),
        ...opacityOf(d),
        ...shadowOf(d),
      };
    case 'ellipse':
      return {
        type: 'ellipse',
        id,
        rect: box,
        color: d.color,
        width: d.strokeWidth,
        ...(d.fill !== null && { fill: d.fill, fillOpacity: d.fillOpacity }),
        ...opacityOf(d),
        ...shadowOf(d),
      };
    case 'highlight':
      return {
        type: 'highlight',
        id,
        rect: rectFromPoints(start, point),
        color: d.highlightColor,
        opacity: HIGHLIGHT_OPACITY,
      };
    case 'blur':
      return { type: 'blur', id, rect: box, mode: d.blurMode, amount: d.blurAmount };
    case 'redact':
      return { type: 'redact', id, rect: box };
    case 'spotlight':
      return {
        type: 'spotlight',
        id,
        rect: box,
        shape: d.spotlightShape,
        ...(d.spotlightDim !== DEFAULT_SPOTLIGHT_DIM && { dim: d.spotlightDim }),
      };
    case 'magnifier':
      return {
        type: 'magnifier',
        id,
        rect: squareFromAnchor(start, point),
        zoom: d.magnifierZoom,
        color: d.color,
        width: Math.max(2, Math.round(d.strokeWidth * 0.8)),
        shadow: { blur: 10, offset: 4 },
      };
    case 'callout':
      return {
        type: 'callout',
        id,
        rect: rectFromPoints(start, point),
        tail: defaultTail(rectFromPoints(start, point)),
        text: '',
        color: d.calloutColor,
        textColor: d.calloutTextColor,
        fontSize: d.fontSize,
        fontWeight: d.fontWeight,
        ...opacityOf(d),
        ...shadowOf(d),
      };
  }
}

/** Whether a drag is big enough (CSS px at the current zoom, via `scale`) to become an element. */
export function isDraftBigEnough(draft: Annotation, scale: number, minCss: number): boolean {
  if ('from' in draft && 'to' in draft) {
    return Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) * scale >= minCss;
  }
  if ('rect' in draft) {
    return (
      Math.max(draft.rect.width, draft.rect.height) * scale >= minCss &&
      Math.min(draft.rect.width, draft.rect.height) * scale >= minCss / 2
    );
  }
  return true;
}

export function penDraft(
  id: string,
  points: Point[],
  d: StyleDefaults,
  highlighter: boolean,
): Annotation {
  return highlighter
    ? {
        type: 'pen',
        id,
        points,
        color: d.highlightColor,
        width: Math.max(d.strokeWidth * 4, 14),
        highlighter: true,
      }
    : {
        type: 'pen',
        id,
        points,
        color: d.color,
        width: d.strokeWidth,
        ...opacityOf(d),
        ...shadowOf(d),
      };
}

export function stepAt(id: string, at: Point, d: StyleDefaults): Annotation {
  return {
    type: 'step',
    id,
    at,
    number: d.stepNumber,
    color: d.color,
    size: Math.max(24, Math.round(d.fontSize * 1.5)),
    ...opacityOf(d),
    ...shadowOf(d),
  };
}

export function stampAt(id: string, at: Point, stamp: StampId, d: StyleDefaults): Annotation {
  return {
    type: 'stamp',
    id,
    at,
    stamp,
    size: Math.max(28, Math.round(d.fontSize * 1.6)),
    color: d.color,
    ...opacityOf(d),
    ...shadowOf(d),
  };
}

export function textDraft(id: string, at: Point, d: StyleDefaults): Annotation {
  return {
    type: 'text',
    id,
    at,
    text: '',
    color: d.color,
    fontSize: d.fontSize,
    fontWeight: d.fontWeight,
    ...(d.family !== 'sans' && { family: d.family }),
    ...(d.italic && { italic: true }),
    ...(d.align !== 'left' && { align: d.align }),
    ...(d.textBackground !== null && { background: d.textBackground }),
    ...(d.outlineColor !== null &&
      d.outlineWidth > 0 && {
        outlineColor: d.outlineColor,
        outlineWidth: d.outlineWidth,
      }),
    ...opacityOf(d),
    ...shadowOf(d),
  };
}

/**
 * Thins a freehand stroke (Ramer-Douglas-Peucker) so a long drag stays a small, smooth path.
 * `epsilon` is in image px. The first and last point always stay.
 */
export function simplifyStroke(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    const a = points[lo] as Point;
    const b = points[hi] as Point;
    let worst = -1;
    let worstDistance = epsilon;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    for (let i = lo + 1; i < hi; i += 1) {
      const p = points[i] as Point;
      const t =
        lengthSq === 0
          ? 0
          : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
      const distance = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  const result = points.filter((_, index) => keep[index]);
  return result.length > MAX_PEN_POINTS ? result.slice(0, MAX_PEN_POINTS) : result;
}
