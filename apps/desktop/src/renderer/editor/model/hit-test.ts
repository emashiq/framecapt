import { arrowDraw, quadPoint } from './arrow';
import { calloutRadius, calloutTail } from './callout';
import {
  aspectFromAnchor,
  constrainTo45,
  containsPoint,
  distanceToRectOutline,
  distanceToSegment,
  enforceAspect,
  expandRect,
  normalizeRect,
  squareFromAnchor,
  translateRect,
  unionRects,
} from './geometry';
import type { AnnotationPatch } from './commands';
import {
  TEXT_LINE_HEIGHT,
  type Annotation,
  type EditorDoc,
  type FontFamilyId,
  type Point,
  type Rect,
  type TextAnnotation,
} from './types';

/** Width in image px of one line of text. Defaults to a rough estimate; the editor passes canvas measureText. */
export type TextMeasure = (
  text: string,
  fontSize: number,
  fontWeight: number,
  family?: FontFamilyId,
  italic?: boolean,
) => number;

export const estimateTextWidth: TextMeasure = (text, fontSize) => text.length * fontSize * 0.56;

export type HandleId =
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'
  | 'from'
  | 'to'
  /** The bend of a curved arrow. */
  | 'ctrl'
  /** The tail of a speech bubble. */
  | 'tail';

export interface Handle {
  id: HandleId;
  point: Point;
}

export function textBounds(
  annotation: TextAnnotation,
  measure: TextMeasure = estimateTextWidth,
): Rect {
  const lines = annotation.text.split('\n');
  const width = Math.max(
    annotation.fontSize * 0.5,
    ...lines.map((line) =>
      measure(
        line,
        annotation.fontSize,
        annotation.fontWeight,
        annotation.family,
        annotation.italic,
      ),
    ),
  );
  return {
    x: annotation.at.x,
    y: annotation.at.y,
    width,
    height: lines.length * annotation.fontSize * TEXT_LINE_HEIGHT,
  };
}

/** Samples of a bezier (8 segments), enough for bounds and hit tests of a gentle curve. */
function curvePoints(from: Point, control: Point, to: Point): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= 8; i += 1) points.push(quadPoint(from, control, to, i / 8));
  return points;
}

function polylineDistance(point: Point, points: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i += 1) {
    best = Math.min(best, distanceToSegment(point, points[i] as Point, points[i + 1] as Point));
  }
  if (points.length === 1)
    best = Math.hypot(point.x - (points[0] as Point).x, point.y - (points[0] as Point).y);
  return best;
}

function boundsOfPoints(points: readonly Point[], pad: number): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

/** The shaft of an arrow as a polyline (two points when straight). */
function arrowShaft(annotation: Extract<Annotation, { type: 'arrow' }>): Point[] {
  const draw = arrowDraw(annotation);
  return draw.control
    ? curvePoints(annotation.from, draw.control, annotation.to)
    : [annotation.from, annotation.to];
}

/** Whether `point` is inside the ellipse inscribed in `rect`, grown by `grow`. */
function inEllipse(rect: Rect, point: Point, grow: number): boolean {
  const rx = rect.width / 2 + grow;
  const ry = rect.height / 2 + grow;
  if (rx <= 0 || ry <= 0) return false;
  const nx = (point.x - (rect.x + rect.width / 2)) / rx;
  const ny = (point.y - (rect.y + rect.height / 2)) / ry;
  return nx * nx + ny * ny <= 1;
}

function distanceToEllipseOutline(point: Point, rect: Rect): number {
  const rx = Math.max(rect.width / 2, 0.5);
  const ry = Math.max(rect.height / 2, 0.5);
  const nx = (point.x - (rect.x + rect.width / 2)) / rx;
  const ny = (point.y - (rect.y + rect.height / 2)) / ry;
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
}

/** The visual extent of an annotation in image px (stroke and arrow head included). */
export function annotationBounds(
  annotation: Annotation,
  measure: TextMeasure = estimateTextWidth,
): Rect {
  switch (annotation.type) {
    case 'arrow': {
      const draw = arrowDraw(annotation);
      const points = [...arrowShaft(annotation)];
      for (const head of [draw.start, draw.end]) {
        if (!head) continue;
        points.push(head.geometry.left, head.geometry.right, head.geometry.tip);
        if (head.style === 'dot') {
          const r = head.dotRadius;
          const c = head.geometry.tip;
          points.push({ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y + r });
        }
      }
      return boundsOfPoints(points, annotation.width / 2);
    }
    case 'line':
    case 'ruler':
      return boundsOfPoints([annotation.from, annotation.to], annotation.width / 2);
    case 'rect':
    case 'ellipse':
    case 'magnifier':
      return expandRect(annotation.rect, annotation.width / 2);
    case 'highlight':
    case 'blur':
    case 'spotlight':
    case 'image':
    case 'redact':
      return annotation.rect;
    case 'pen':
      return boundsOfPoints(annotation.points, annotation.width / 2);
    case 'step':
    case 'stamp': {
      const r = annotation.size / 2;
      return {
        x: annotation.at.x - r,
        y: annotation.at.y - r,
        width: annotation.size,
        height: annotation.size,
      };
    }
    case 'callout':
      return unionRects([annotation.rect, boundsOfPoints([annotation.tail], 0)]) ?? annotation.rect;
    case 'text':
      return textBounds(annotation, measure);
  }
}

function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const sign = (p1: Point, p2: Point, p3: Point): number =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function hits(
  annotation: Annotation,
  point: Point,
  tolerance: number,
  measure: TextMeasure,
): boolean {
  switch (annotation.type) {
    case 'arrow': {
      const reach = annotation.width / 2 + tolerance;
      if (polylineDistance(point, arrowShaft(annotation)) <= reach) return true;
      const draw = arrowDraw(annotation);
      for (const head of [draw.start, draw.end]) {
        if (!head) continue;
        const g = head.geometry;
        if (head.style === 'dot') {
          if (Math.hypot(point.x - g.tip.x, point.y - g.tip.y) <= head.dotRadius + tolerance) {
            return true;
          }
        } else if (
          g.headLength > 0 &&
          (distanceToSegment(point, g.left, g.tip) <= tolerance + annotation.width ||
            distanceToSegment(point, g.right, g.tip) <= tolerance + annotation.width ||
            (head.style === 'triangle' && pointInTriangle(point, g.tip, g.left, g.right)))
        ) {
          return true;
        }
      }
      return false;
    }
    case 'line':
    case 'ruler':
      return (
        distanceToSegment(point, annotation.from, annotation.to) <= annotation.width / 2 + tolerance
      );
    case 'rect':
      if ((annotation.fill ?? null) !== null && (annotation.fillOpacity ?? 1) > 0) {
        return containsPoint(expandRect(annotation.rect, tolerance), point);
      }
      return (
        distanceToRectOutline(point, annotation.rect) <=
        Math.max(annotation.width, 1) / 2 + tolerance
      );
    case 'ellipse':
      if ((annotation.fill ?? null) !== null && (annotation.fillOpacity ?? 1) > 0) {
        return inEllipse(annotation.rect, point, tolerance);
      }
      return (
        distanceToEllipseOutline(point, annotation.rect) <=
        Math.max(annotation.width, 1) / 2 + tolerance
      );
    case 'magnifier':
      return inEllipse(annotation.rect, point, tolerance);
    case 'highlight':
    case 'blur':
    case 'image':
    case 'redact':
      return containsPoint(expandRect(annotation.rect, tolerance), point);
    case 'spotlight':
      return annotation.shape === 'ellipse'
        ? distanceToEllipseOutline(point, annotation.rect) <= tolerance * 1.5
        : distanceToRectOutline(point, annotation.rect) <= tolerance * 1.5;
    case 'pen':
      return polylineDistance(point, annotation.points) <= annotation.width / 2 + tolerance;
    case 'step':
      return (
        Math.hypot(point.x - annotation.at.x, point.y - annotation.at.y) <=
        annotation.size / 2 + tolerance
      );
    case 'stamp':
      return containsPoint(expandRect(annotationBounds(annotation), tolerance), point);
    case 'callout': {
      if (containsPoint(expandRect(annotation.rect, tolerance), point)) return true;
      const tail = calloutTail(annotation.rect, annotation.tail, calloutRadius(annotation));
      return !!tail && pointInTriangle(point, tail.a, tail.b, tail.tip);
    }
    case 'text':
      return containsPoint(expandRect(textBounds(annotation, measure), tolerance), point);
  }
}

/**
 * The topmost annotation under `point` (image px), or null. Redactions are always on top at
 * export, so they are tested first; the rest from the last drawn to the first.
 */
export function hitTest(
  doc: EditorDoc,
  point: Point,
  tolerance: number,
  measure: TextMeasure = estimateTextWidth,
): Annotation | null {
  for (let i = doc.annotations.length - 1; i >= 0; i -= 1) {
    const annotation = doc.annotations[i];
    if (annotation?.type === 'redact' && hits(annotation, point, tolerance, measure)) {
      return annotation;
    }
  }
  for (let i = doc.annotations.length - 1; i >= 0; i -= 1) {
    const annotation = doc.annotations[i];
    if (annotation && annotation.type !== 'redact' && hits(annotation, point, tolerance, measure)) {
      return annotation;
    }
  }
  return null;
}

const RECT_HANDLES: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function rectHandles(rect: Rect): Handle[] {
  const { x, y, width, height } = rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const at: Record<string, Point> = {
    nw: { x, y },
    n: { x: cx, y },
    ne: { x: x + width, y },
    e: { x: x + width, y: cy },
    se: { x: x + width, y: y + height },
    s: { x: cx, y: y + height },
    sw: { x, y: y + height },
    w: { x, y: cy },
  };
  return RECT_HANDLES.map((id) => ({ id, point: at[id] as Point }));
}

/** Handles of a selected annotation: 8 for rectangles, both ends for lines, one scale handle for text. */
export function handlesFor(
  annotation: Annotation,
  measure: TextMeasure = estimateTextWidth,
): Handle[] {
  switch (annotation.type) {
    case 'arrow': {
      const handles: Handle[] = [
        { id: 'from', point: annotation.from },
        { id: 'to', point: annotation.to },
      ];
      const control = arrowDraw(annotation).control;
      if (control)
        handles.push({
          id: 'ctrl',
          point: quadPoint(annotation.from, control, annotation.to, 0.5),
        });
      return handles;
    }
    case 'line':
    case 'ruler':
      return [
        { id: 'from', point: annotation.from },
        { id: 'to', point: annotation.to },
      ];
    case 'rect':
    case 'ellipse':
    case 'highlight':
    case 'blur':
    case 'spotlight':
    case 'magnifier':
    case 'image':
    case 'redact':
      return rectHandles(annotation.rect);
    case 'callout':
      return [...rectHandles(annotation.rect), { id: 'tail', point: annotation.tail }];
    case 'step':
    case 'stamp':
      return [{ id: 'e', point: { x: annotation.at.x + annotation.size / 2, y: annotation.at.y } }];
    case 'pen':
      return [];
    case 'text': {
      const box = textBounds(annotation, measure);
      return [{ id: 'se', point: { x: box.x + box.width, y: box.y + box.height } }];
    }
  }
}

/** The handle within `reach` image px of `point` (nearest wins), or null. */
export function hitHandle(handles: readonly Handle[], point: Point, reach: number): Handle | null {
  let best: Handle | null = null;
  let bestDistance = reach;
  for (const handle of handles) {
    const distance = Math.hypot(handle.point.x - point.x, handle.point.y - point.y);
    if (distance <= bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Resizes `rect` by dragging `handle` to `point`. Dragging past the opposite edge flips the
 * rectangle. With `square`, corner handles keep a square anchored at the opposite corner.
 */
export function resizeRect(rect: Rect, handle: HandleId, point: Point, square = false): Rect {
  const isCorner = handle.length === 2;
  if (square && isCorner) {
    const anchor: Point = {
      x: handle.includes('w') ? rect.x + rect.width : rect.x,
      y: handle.includes('n') ? rect.y + rect.height : rect.y,
    };
    return squareFromAnchor(anchor, point);
  }
  let x0 = rect.x;
  let y0 = rect.y;
  let x1 = rect.x + rect.width;
  let y1 = rect.y + rect.height;
  if (handle.includes('w')) x0 = point.x;
  if (handle.includes('e')) x1 = point.x;
  if (handle.includes('n')) y0 = point.y;
  if (handle.includes('s')) y1 = point.y;
  return normalizeRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

const UNBOUNDED: Rect = { x: -1e6, y: -1e6, width: 2e6, height: 2e6 };

/**
 * Resizes a picture's rectangle by dragging `handle` to `point`, keeping its width:height ratio
 * (the opposite corner or the opposite edge's middle stays put). With `free` the ratio changes.
 */
function resizeKeepingRatio(rect: Rect, handle: HandleId, point: Point, free: boolean): Rect {
  if (free || rect.width <= 0 || rect.height <= 0) return resizeRect(rect, handle, point);
  const ratio = rect.width / rect.height;
  if (handle.length === 2) {
    const anchor: Point = {
      x: handle.includes('w') ? rect.x + rect.width : rect.x,
      y: handle.includes('n') ? rect.y + rect.height : rect.y,
    };
    return aspectFromAnchor(anchor, point, ratio);
  }
  return enforceAspect(resizeRect(rect, handle, point), rect, handle, ratio, UNBOUNDED);
}

/** The patch that moves an annotation by (dx, dy). */
export function moveAnnotation(annotation: Annotation, dx: number, dy: number): AnnotationPatch {
  switch (annotation.type) {
    case 'arrow':
    case 'line':
    case 'ruler':
      return {
        from: { x: annotation.from.x + dx, y: annotation.from.y + dy },
        to: { x: annotation.to.x + dx, y: annotation.to.y + dy },
      };
    case 'rect':
    case 'ellipse':
    case 'highlight':
    case 'blur':
    case 'spotlight':
    case 'magnifier':
    case 'image':
    case 'redact':
      return { rect: translateRect(annotation.rect, dx, dy) };
    case 'callout':
      return {
        rect: translateRect(annotation.rect, dx, dy),
        tail: { x: annotation.tail.x + dx, y: annotation.tail.y + dy },
      };
    case 'pen':
      return { points: annotation.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case 'step':
    case 'stamp':
    case 'text':
      return { at: { x: annotation.at.x + dx, y: annotation.at.y + dy } };
  }
}

/** The patch for dragging one handle of `annotation` to `point`. */
export function resizeAnnotation(
  annotation: Annotation,
  handle: HandleId,
  point: Point,
  shift: boolean,
  measure: TextMeasure = estimateTextWidth,
): AnnotationPatch {
  switch (annotation.type) {
    case 'arrow':
      if (handle === 'ctrl') {
        // The handle sits on the curve (t = 1/2): the bend that moves the curve there.
        const dx = annotation.to.x - annotation.from.x;
        const dy = annotation.to.y - annotation.from.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) return {};
        const mx = (annotation.from.x + annotation.to.x) / 2;
        const my = (annotation.from.y + annotation.to.y) / 2;
        return { bend: ((point.x - mx) * -dy + (point.y - my) * dx) / lengthSq };
      }
      if (handle === 'from') {
        return { from: shift ? constrainTo45(annotation.to, point) : point };
      }
      return { to: shift ? constrainTo45(annotation.from, point) : point };
    case 'line':
    case 'ruler':
      if (handle === 'from') {
        return { from: shift ? constrainTo45(annotation.to, point) : point };
      }
      return { to: shift ? constrainTo45(annotation.from, point) : point };
    case 'rect':
    case 'ellipse':
    case 'highlight':
    case 'blur':
    case 'spotlight':
    case 'magnifier':
    case 'redact':
      return { rect: resizeRect(annotation.rect, handle, point, shift) };
    case 'image':
      // A picture keeps its proportions; Shift frees them.
      return { rect: resizeKeepingRatio(annotation.rect, handle, point, shift) };
    case 'callout':
      if (handle === 'tail') return { tail: point };
      return { rect: resizeRect(annotation.rect, handle, point, shift) };
    case 'step':
    case 'stamp':
      return {
        size: Math.round(
          Math.min(
            1000,
            Math.max(8, 2 * Math.hypot(point.x - annotation.at.x, point.y - annotation.at.y)),
          ),
        ),
      };
    case 'pen':
      return {};
    case 'text': {
      const box = textBounds(annotation, measure);
      const scale = Math.max(0.1, (point.y - box.y) / Math.max(1, box.height));
      return { fontSize: Math.min(400, Math.max(6, Math.round(annotation.fontSize * scale))) };
    }
  }
}
