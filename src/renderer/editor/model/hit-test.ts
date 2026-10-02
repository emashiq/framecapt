import { arrowGeometry } from './arrow';
import {
  constrainTo45,
  containsPoint,
  distanceToRectOutline,
  distanceToSegment,
  expandRect,
  normalizeRect,
  squareFromAnchor,
  translateRect,
} from './geometry';
import type { AnnotationPatch } from './commands';
import {
  TEXT_LINE_HEIGHT,
  type Annotation,
  type EditorDoc,
  type Point,
  type Rect,
  type TextAnnotation,
} from './types';

/** Width in image px of one line of text. Defaults to a rough estimate; the editor passes canvas measureText. */
export type TextMeasure = (text: string, fontSize: number, fontWeight: number) => number;

export const estimateTextWidth: TextMeasure = (text, fontSize) => text.length * fontSize * 0.56;

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'from' | 'to';

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
    ...lines.map((line) => measure(line, annotation.fontSize, annotation.fontWeight)),
  );
  return {
    x: annotation.at.x,
    y: annotation.at.y,
    width,
    height: lines.length * annotation.fontSize * TEXT_LINE_HEIGHT,
  };
}

/** The visual extent of an annotation in image px (stroke and arrow head included). */
export function annotationBounds(
  annotation: Annotation,
  measure: TextMeasure = estimateTextWidth,
): Rect {
  switch (annotation.type) {
    case 'arrow': {
      const geometry = arrowGeometry(annotation.from, annotation.to, annotation.width);
      const xs = [annotation.from.x, geometry.left.x, geometry.right.x, annotation.to.x];
      const ys = [annotation.from.y, geometry.left.y, geometry.right.y, annotation.to.y];
      const pad = annotation.width / 2;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
    }
    case 'rect':
      return expandRect(annotation.rect, annotation.width / 2);
    case 'redact':
      return annotation.rect;
    case 'text':
      return textBounds(annotation, measure);
  }
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
      if (distanceToSegment(point, annotation.from, annotation.to) <= reach) return true;
      const geometry = arrowGeometry(annotation.from, annotation.to, annotation.width);
      return (
        geometry.headLength > 0 &&
        distanceToSegment(point, geometry.shaftEnd, geometry.tip) <=
          geometry.headLength * 0.45 + tolerance
      );
    }
    case 'rect':
      return distanceToRectOutline(point, annotation.rect) <= annotation.width / 2 + tolerance;
    case 'redact':
      return containsPoint(expandRect(annotation.rect, tolerance), point);
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

/** Handles of a selected annotation: 8 for rectangles, both ends for arrows, one scale handle for text. */
export function handlesFor(
  annotation: Annotation,
  measure: TextMeasure = estimateTextWidth,
): Handle[] {
  switch (annotation.type) {
    case 'arrow':
      return [
        { id: 'from', point: annotation.from },
        { id: 'to', point: annotation.to },
      ];
    case 'rect':
    case 'redact':
      return rectHandles(annotation.rect);
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

/** The patch that moves an annotation by (dx, dy). */
export function moveAnnotation(annotation: Annotation, dx: number, dy: number): AnnotationPatch {
  switch (annotation.type) {
    case 'arrow':
      return {
        from: { x: annotation.from.x + dx, y: annotation.from.y + dy },
        to: { x: annotation.to.x + dx, y: annotation.to.y + dy },
      };
    case 'rect':
    case 'redact':
      return { rect: translateRect(annotation.rect, dx, dy) };
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
      if (handle === 'from') {
        return { from: shift ? constrainTo45(annotation.to, point) : point };
      }
      return { to: shift ? constrainTo45(annotation.from, point) : point };
    case 'rect':
    case 'redact':
      return { rect: resizeRect(annotation.rect, handle, point, shift) };
    case 'text': {
      const box = textBounds(annotation, measure);
      const scale = Math.max(0.1, (point.y - box.y) / Math.max(1, box.height));
      return { fontSize: Math.min(400, Math.max(6, Math.round(annotation.fontSize * scale))) };
    }
  }
}
