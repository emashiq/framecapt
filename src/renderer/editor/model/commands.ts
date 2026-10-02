import { clampRectToImage, normalizeRect } from './geometry';
import type { Annotation, EditorDoc, Point, Rect } from './types';

/** Fields of any annotation that `update` may change. `id` and `type` never change. */
export interface AnnotationPatch {
  from?: Point;
  to?: Point;
  rect?: Rect;
  at?: Point;
  text?: string;
  color?: string;
  width?: number;
  fontSize?: number;
  fontWeight?: number;
}

export type Command =
  | { type: 'add'; annotation: Annotation }
  | { type: 'update'; id: string; patch: AnnotationPatch }
  | { type: 'remove'; id: string }
  | { type: 'setCrop'; crop: Rect | null }
  /** Moves an annotation to `toIndex` in the z-order (clamped). */
  | { type: 'reorder'; id: string; toIndex: number };

const finite = (value: number): boolean => Number.isFinite(value);
const finitePoint = (point: Point): boolean => finite(point.x) && finite(point.y);
const finiteRect = (rect: Rect): boolean =>
  finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height);

/** Which patch fields each annotation type accepts. A redaction accepts ONLY its rectangle. */
const ALLOWED: Record<Annotation['type'], readonly (keyof AnnotationPatch)[]> = {
  arrow: ['from', 'to', 'color', 'width'],
  rect: ['rect', 'color', 'width'],
  text: ['at', 'text', 'color', 'fontSize', 'fontWeight'],
  redact: ['rect'],
};

function applyPatch(annotation: Annotation, patch: AnnotationPatch): Annotation {
  const next: Record<string, unknown> = { ...annotation };
  for (const key of ALLOWED[annotation.type]) {
    const value = patch[key];
    if (value === undefined) continue;
    next[key] = value;
  }
  if ('rect' in next && patch.rect && ALLOWED[annotation.type].includes('rect')) {
    next.rect = normalizeRect(patch.rect);
  }
  return next as unknown as Annotation;
}

function isValid(annotation: Annotation): boolean {
  switch (annotation.type) {
    case 'arrow':
      return finitePoint(annotation.from) && finitePoint(annotation.to) && finite(annotation.width);
    case 'rect':
      return finiteRect(annotation.rect) && finite(annotation.width);
    case 'text':
      return finitePoint(annotation.at) && finite(annotation.fontSize) && annotation.fontSize > 0;
    case 'redact':
      return finiteRect(annotation.rect);
  }
}

/** Builds a redaction. There is no color or opacity to pass. */
export function createRedact(id: string, rect: Rect): Annotation {
  return { type: 'redact', id, rect: normalizeRect(rect) };
}

function sanitize(annotation: Annotation): Annotation {
  switch (annotation.type) {
    case 'redact':
      // Rebuilt from its rectangle only, whatever else was attached to the object.
      return createRedact(annotation.id, annotation.rect);
    case 'rect':
      return { ...annotation, rect: normalizeRect(annotation.rect) };
    default:
      return annotation;
  }
}

/**
 * Pure reducer: returns a new document (never mutates) or the SAME document when the command has
 * no effect (unknown id, invalid values, identical crop), which history uses to skip no-ops.
 */
export function apply(doc: EditorDoc, command: Command): EditorDoc {
  switch (command.type) {
    case 'add': {
      const annotation = sanitize(command.annotation);
      if (!isValid(annotation)) return doc;
      if (doc.annotations.some((existing) => existing.id === annotation.id)) return doc;
      return { ...doc, annotations: [...doc.annotations, annotation] };
    }
    case 'update': {
      const index = doc.annotations.findIndex((annotation) => annotation.id === command.id);
      const current = doc.annotations[index];
      if (!current) return doc;
      const next = applyPatch(current, command.patch);
      if (!isValid(next) || JSON.stringify(next) === JSON.stringify(current)) return doc;
      const annotations = doc.annotations.slice();
      annotations[index] = next;
      return { ...doc, annotations };
    }
    case 'remove': {
      if (!doc.annotations.some((annotation) => annotation.id === command.id)) return doc;
      return { ...doc, annotations: doc.annotations.filter((a) => a.id !== command.id) };
    }
    case 'setCrop': {
      if (command.crop === null) return doc.crop === null ? doc : { ...doc, crop: null };
      const clamped = clampRectToImage(command.crop, doc);
      if (!clamped) return doc;
      const full =
        clamped.x === 0 &&
        clamped.y === 0 &&
        clamped.width === doc.width &&
        clamped.height === doc.height;
      const crop = full ? null : clamped;
      const same =
        crop === doc.crop ||
        (crop !== null &&
          doc.crop !== null &&
          crop.x === doc.crop.x &&
          crop.y === doc.crop.y &&
          crop.width === doc.crop.width &&
          crop.height === doc.crop.height);
      return same ? doc : { ...doc, crop };
    }
    case 'reorder': {
      const from = doc.annotations.findIndex((annotation) => annotation.id === command.id);
      if (from < 0) return doc;
      const to = Math.max(0, Math.min(doc.annotations.length - 1, Math.trunc(command.toIndex)));
      if (to === from) return doc;
      const annotations = doc.annotations.slice();
      const [moved] = annotations.splice(from, 1);
      if (!moved) return doc;
      annotations.splice(to, 0, moved);
      return { ...doc, annotations };
    }
  }
}
