import type { Command } from './commands';
import { unionRects } from './geometry';
import { annotationBounds, estimateTextWidth, moveAnnotation, type TextMeasure } from './hit-test';
import type { Annotation, EditorDoc, Rect } from './types';

// --- z-order ---------------------------------------------------------------------------------

export type ZMove = 'front' | 'back' | 'forward' | 'backward';

/** The command that moves the annotations `ids` in the z-order, or null when nothing would change. */
export function zOrderCommand(doc: EditorDoc, ids: readonly string[], move: ZMove): Command | null {
  const chosen = new Set(ids);
  const order = doc.annotations.map((annotation) => annotation.id);
  let next = order.slice();
  if (move === 'front') {
    next = [...order.filter((id) => !chosen.has(id)), ...order.filter((id) => chosen.has(id))];
  } else if (move === 'back') {
    next = [...order.filter((id) => chosen.has(id)), ...order.filter((id) => !chosen.has(id))];
  } else if (move === 'forward') {
    for (let i = next.length - 2; i >= 0; i -= 1) {
      if (chosen.has(next[i] as string) && !chosen.has(next[i + 1] as string)) {
        [next[i], next[i + 1]] = [next[i + 1] as string, next[i] as string];
      }
    }
  } else {
    for (let i = 1; i < next.length; i += 1) {
      if (chosen.has(next[i] as string) && !chosen.has(next[i - 1] as string)) {
        [next[i], next[i - 1]] = [next[i - 1] as string, next[i] as string];
      }
    }
  }
  return next.every((id, index) => id === order[index]) ? null : { type: 'order', ids: next };
}

// --- duplicate -------------------------------------------------------------------------------

/** Copies of the annotations `ids` (in z-order), shifted by `offset`, as one command. */
export function duplicateCommand(
  doc: EditorDoc,
  ids: readonly string[],
  offset: number,
  newId: () => string,
): { command: Command; ids: string[] } | null {
  const chosen = new Set(ids);
  const copies: Command[] = [];
  const created: string[] = [];
  for (const annotation of doc.annotations) {
    if (!chosen.has(annotation.id)) continue;
    const id = newId();
    const moved = {
      ...annotation,
      id,
      ...moveAnnotation(annotation, offset, offset),
    } as Annotation;
    copies.push({ type: 'add', annotation: moved });
    created.push(id);
  }
  return copies.length === 0
    ? null
    : { command: { type: 'batch', commands: copies }, ids: created };
}

// --- align and distribute ----------------------------------------------------------------------

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

function selection(doc: EditorDoc, ids: readonly string[]): Annotation[] {
  const chosen = new Set(ids);
  return doc.annotations.filter((annotation) => chosen.has(annotation.id));
}

function moveBy(annotation: Annotation, dx: number, dy: number): Command {
  return { type: 'update', id: annotation.id, patch: moveAnnotation(annotation, dx, dy) };
}

/**
 * Aligns the annotations to each other (two or more) or, for one, to `frame` (the image).
 * Returns null when nothing moves.
 */
export function alignCommand(
  doc: EditorDoc,
  ids: readonly string[],
  mode: AlignMode,
  frame: Rect,
  measure: TextMeasure = estimateTextWidth,
): Command | null {
  const items = selection(doc, ids);
  if (items.length === 0) return null;
  const boxes = items.map((item) => annotationBounds(item, measure));
  const reference = items.length === 1 ? frame : (unionRects(boxes) as Rect);
  const commands: Command[] = [];
  items.forEach((item, index) => {
    const box = boxes[index] as Rect;
    let dx = 0;
    let dy = 0;
    if (mode === 'left') dx = reference.x - box.x;
    else if (mode === 'center') dx = reference.x + reference.width / 2 - (box.x + box.width / 2);
    else if (mode === 'right') dx = reference.x + reference.width - (box.x + box.width);
    else if (mode === 'top') dy = reference.y - box.y;
    else if (mode === 'middle') dy = reference.y + reference.height / 2 - (box.y + box.height / 2);
    else dy = reference.y + reference.height - (box.y + box.height);
    if (dx !== 0 || dy !== 0) commands.push(moveBy(item, dx, dy));
  });
  return commands.length === 0 ? null : { type: 'batch', commands };
}

/** Spaces three or more annotations evenly between the outermost two. Null when fewer or no change. */
export function distributeCommand(
  doc: EditorDoc,
  ids: readonly string[],
  axis: DistributeAxis,
  measure: TextMeasure = estimateTextWidth,
): Command | null {
  const items = selection(doc, ids).map((annotation) => ({
    annotation,
    box: annotationBounds(annotation, measure),
  }));
  if (items.length < 3) return null;
  const horizontal = axis === 'horizontal';
  const start = (box: Rect): number => (horizontal ? box.x : box.y);
  const size = (box: Rect): number => (horizontal ? box.width : box.height);
  items.sort((a, b) => start(a.box) - start(b.box));
  const first = items[0]?.box as Rect;
  const last = items[items.length - 1]?.box as Rect;
  const span = start(last) + size(last) - start(first);
  const total = items.reduce((sum, item) => sum + size(item.box), 0);
  const gap = (span - total) / (items.length - 1);
  const commands: Command[] = [];
  let cursor = start(first);
  for (const item of items) {
    const delta = cursor - start(item.box);
    if (Math.abs(delta) > 1e-9) {
      commands.push(moveBy(item.annotation, horizontal ? delta : 0, horizontal ? 0 : delta));
    }
    cursor += size(item.box) + gap;
  }
  return commands.length === 0 ? null : { type: 'batch', commands };
}

// --- snapping ----------------------------------------------------------------------------------

export interface Guide {
  axis: 'x' | 'y';
  /** The coordinate of the line (x for a vertical guide, y for a horizontal one). */
  position: number;
  /** The extent of the line along the other axis. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

interface Line {
  position: number;
  /** Extent of the thing the line belongs to, along the other axis. */
  from: number;
  to: number;
}

const xLines = (rect: Rect): Line[] =>
  [rect.x, rect.x + rect.width / 2, rect.x + rect.width].map((position) => ({
    position,
    from: rect.y,
    to: rect.y + rect.height,
  }));
const yLines = (rect: Rect): Line[] =>
  [rect.y, rect.y + rect.height / 2, rect.y + rect.height].map((position) => ({
    position,
    from: rect.x,
    to: rect.x + rect.width,
  }));

function nearest(moving: readonly Line[], targets: readonly Line[], threshold: number) {
  let best: { delta: number; moving: Line; target: Line } | null = null;
  for (const a of moving) {
    for (const b of targets) {
      const delta = b.position - a.position;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, moving: a, target: b };
      }
    }
  }
  return best;
}

/**
 * Snaps a rectangle being moved (`moving`, at its proposed position) to the edges and centers of
 * the canvas `frame` and of `others`. Returns the correction to add and the guide lines to show.
 * `threshold` is in image px.
 */
export function snapMove(
  moving: Rect,
  others: readonly Rect[],
  frame: Rect,
  threshold: number,
): SnapResult {
  const targets = [frame, ...others];
  const bestX = nearest(xLines(moving), targets.flatMap(xLines), threshold);
  const bestY = nearest(yLines(moving), targets.flatMap(yLines), threshold);
  const dx = bestX?.delta ?? 0;
  const dy = bestY?.delta ?? 0;
  const guides: Guide[] = [];
  if (bestX) {
    guides.push({
      axis: 'x',
      position: bestX.target.position,
      from: Math.min(bestX.moving.from + dy, bestX.target.from),
      to: Math.max(bestX.moving.to + dy, bestX.target.to),
    });
  }
  if (bestY) {
    guides.push({
      axis: 'y',
      position: bestY.target.position,
      from: Math.min(bestY.moving.from + dx, bestY.target.from),
      to: Math.max(bestY.moving.to + dx, bestY.target.to),
    });
  }
  return { dx, dy, guides };
}
