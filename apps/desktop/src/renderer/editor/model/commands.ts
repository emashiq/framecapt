import { clampRectToImage, normalizeRect } from './geometry';
import {
  STAMP_IDS,
  type Annotation,
  type ArrowStyle,
  type Beautify,
  type BlurMode,
  type DashStyle,
  type EditorDoc,
  type FontFamilyId,
  type HeadStyle,
  type Point,
  type Rect,
  type Shadow,
  type StampId,
  type TextAlign,
} from './types';

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
  style?: ArrowStyle;
  bend?: number;
  startHead?: HeadStyle;
  endHead?: HeadStyle;
  dash?: DashStyle;
  /** null removes the fill, background or outline. */
  fill?: string | null;
  fillOpacity?: number;
  radius?: number;
  opacity?: number;
  /** null removes the shadow. */
  shadow?: Shadow | null;
  points?: Point[];
  mode?: BlurMode;
  amount?: number;
  number?: number;
  size?: number;
  tail?: Point;
  textColor?: string;
  family?: FontFamilyId;
  italic?: boolean;
  align?: TextAlign;
  background?: string | null;
  outlineColor?: string | null;
  outlineWidth?: number;
  shape?: 'rect' | 'ellipse';
  dim?: number;
  zoom?: number;
  stamp?: StampId;
  highlighter?: boolean;
}

export type Command =
  | { type: 'add'; annotation: Annotation }
  | { type: 'update'; id: string; patch: AnnotationPatch }
  | { type: 'remove'; id: string }
  | { type: 'setCrop'; crop: Rect | null }
  /** Moves an annotation to `toIndex` in the z-order (clamped). */
  | { type: 'reorder'; id: string; toIndex: number }
  /** Sets the whole z-order (`ids` must be every annotation id, bottom first). */
  | { type: 'order'; ids: string[] }
  /** Sets (or with null removes) the frame around the export. */
  | { type: 'setBeautify'; beautify: Beautify | null }
  /** Several commands as ONE undo step (group move, align, delete several). */
  | { type: 'batch'; commands: Command[] };

const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);
const finitePoint = (point: Point | undefined): point is Point =>
  point !== undefined && finite(point.x) && finite(point.y);
const finiteRect = (rect: Rect | undefined): rect is Rect =>
  rect !== undefined &&
  finite(rect.x) &&
  finite(rect.y) &&
  finite(rect.width) &&
  finite(rect.height);

const SHAPE_STYLE = ['opacity', 'shadow'] as const;

/** Which patch fields each annotation type accepts. A redaction accepts ONLY its rectangle. */
const ALLOWED: Record<Annotation['type'], readonly (keyof AnnotationPatch)[]> = {
  arrow: ['from', 'to', 'color', 'width', 'style', 'bend', 'startHead', 'endHead', ...SHAPE_STYLE],
  line: ['from', 'to', 'color', 'width', 'dash', ...SHAPE_STYLE],
  rect: ['rect', 'color', 'width', 'fill', 'fillOpacity', 'radius', ...SHAPE_STYLE],
  ellipse: ['rect', 'color', 'width', 'fill', 'fillOpacity', ...SHAPE_STYLE],
  highlight: ['rect', 'color', 'opacity'],
  pen: ['points', 'color', 'width', 'highlighter', ...SHAPE_STYLE],
  blur: ['rect', 'mode', 'amount'],
  step: ['at', 'number', 'color', 'size', ...SHAPE_STYLE],
  callout: [
    'rect',
    'tail',
    'text',
    'color',
    'textColor',
    'fontSize',
    'fontWeight',
    'radius',
    ...SHAPE_STYLE,
  ],
  text: [
    'at',
    'text',
    'color',
    'fontSize',
    'fontWeight',
    'family',
    'italic',
    'align',
    'background',
    'outlineColor',
    'outlineWidth',
    ...SHAPE_STYLE,
  ],
  spotlight: ['rect', 'shape', 'dim'],
  magnifier: ['rect', 'zoom', 'color', 'width', ...SHAPE_STYLE],
  stamp: ['at', 'stamp', 'size', 'color', ...SHAPE_STYLE],
  ruler: ['from', 'to', 'color', 'width', ...SHAPE_STYLE],
  redact: ['rect'],
};

/** Fields whose `null` removes the key from the annotation. */
const CLEARABLE = new Set<keyof AnnotationPatch>(['shadow']);

function applyPatch(annotation: Annotation, patch: AnnotationPatch): Annotation {
  const next: Record<string, unknown> = { ...annotation };
  for (const key of ALLOWED[annotation.type]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null && CLEARABLE.has(key)) delete next[key];
    else next[key] = value;
  }
  return clampAnnotation(next as unknown as Annotation);
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Largest number of points of one freehand stroke (keeps documents and hit tests bounded). */
export const MAX_PEN_POINTS = 4000;
export const MAX_TEXT_LENGTH = 2000;

/** Brings every numeric field into its allowed range. Only touches fields the type has. */
function clampAnnotation(annotation: Annotation): Annotation {
  const next = { ...annotation } as Record<string, unknown> & Annotation;
  const set = (key: string, min: number, max: number): void => {
    const value = next[key];
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = clamp(value, min, max);
  };
  set('opacity', 0, 1);
  set('fillOpacity', 0, 1);
  set('dim', 0, 1);
  set('radius', 0, 500);
  set('outlineWidth', 0, 100);
  set('amount', 1, 60);
  set('zoom', 1.25, 8);
  set('bend', -2, 2);
  if ('width' in next) set('width', 0, 200);
  if ('size' in next) set('size', 8, 1000);
  if (next.type === 'text' || next.type === 'callout') set('fontSize', 4, 600);
  if (next.type === 'step') set('number', 0, 9999);
  if (next.type === 'step' && typeof next.number === 'number') {
    next.number = Math.round(next.number);
  }
  if ((next.type === 'text' || next.type === 'callout') && typeof next.text === 'string') {
    next.text = next.text.slice(0, MAX_TEXT_LENGTH);
  }
  const shadow = (next as { shadow?: Shadow }).shadow;
  if (shadow && typeof shadow === 'object') {
    next.shadow = {
      blur: clamp(Number.isFinite(shadow.blur) ? shadow.blur : 0, 0, 200),
      offset: clamp(Number.isFinite(shadow.offset) ? shadow.offset : 0, -200, 200),
    };
  }
  if ('rect' in next) {
    next.rect = normalizeRect(next.rect as Rect);
  }
  if (next.type === 'pen') next.points = next.points.slice(0, MAX_PEN_POINTS);
  return next;
}

function isValid(annotation: Annotation): boolean {
  switch (annotation.type) {
    case 'arrow':
    case 'line':
    case 'ruler':
      return finitePoint(annotation.from) && finitePoint(annotation.to) && finite(annotation.width);
    case 'rect':
    case 'ellipse':
    case 'magnifier':
      return finiteRect(annotation.rect) && finite(annotation.width);
    case 'highlight':
    case 'blur':
    case 'spotlight':
    case 'redact':
      return finiteRect(annotation.rect);
    case 'pen':
      return (
        annotation.points.length > 0 &&
        annotation.points.every((point) => finitePoint(point)) &&
        finite(annotation.width)
      );
    case 'step':
      return finitePoint(annotation.at) && finite(annotation.size);
    case 'stamp':
      return (
        finitePoint(annotation.at) &&
        finite(annotation.size) &&
        (STAMP_IDS as readonly string[]).includes(annotation.stamp)
      );
    case 'callout':
      return (
        finiteRect(annotation.rect) &&
        finitePoint(annotation.tail) &&
        finite(annotation.fontSize) &&
        annotation.fontSize > 0
      );
    case 'text':
      return finitePoint(annotation.at) && finite(annotation.fontSize) && annotation.fontSize > 0;
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
    default:
      return clampAnnotation(annotation);
  }
}

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

/** Frame values are brought into range; null (or no padding at all) removes the frame. */
function sanitizeBeautify(beautify: Beautify | null): Beautify | null {
  if (!beautify) return null;
  const nums = [
    beautify.padding,
    beautify.radius,
    beautify.shadowBlur,
    beautify.shadowOffset,
    beautify.shadowOpacity,
  ];
  if (!nums.every((value) => Number.isFinite(value))) return null;
  const background =
    beautify.background.kind === 'gradient'
      ? {
          ...beautify.background,
          angle: Number.isFinite(beautify.background.angle) ? beautify.background.angle : 135,
        }
      : beautify.background;
  return {
    background,
    padding: clamp(Math.round(beautify.padding), 0, 400),
    radius: clamp(Math.round(beautify.radius), 0, 200),
    shadowBlur: clamp(Math.round(beautify.shadowBlur), 0, 200),
    shadowOffset: clamp(Math.round(beautify.shadowOffset), -200, 200),
    shadowOpacity: clamp(beautify.shadowOpacity, 0, 1),
  };
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
      return sameRect(crop, doc.crop) ? doc : { ...doc, crop };
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
    case 'order': {
      const byId = new Map(doc.annotations.map((annotation) => [annotation.id, annotation]));
      if (command.ids.length !== byId.size || new Set(command.ids).size !== byId.size) return doc;
      const annotations: Annotation[] = [];
      for (const id of command.ids) {
        const annotation = byId.get(id);
        if (!annotation) return doc;
        annotations.push(annotation);
      }
      return annotations.every((annotation, index) => annotation === doc.annotations[index])
        ? doc
        : { ...doc, annotations };
    }
    case 'setBeautify': {
      const beautify = sanitizeBeautify(command.beautify);
      const before = doc.beautify ?? null;
      if (JSON.stringify(beautify) === JSON.stringify(before)) return doc;
      const { beautify: _old, ...rest } = doc;
      return beautify ? { ...rest, beautify } : rest;
    }
    case 'batch': {
      let next = doc;
      for (const inner of command.commands) next = apply(next, inner);
      return next;
    }
  }
}
