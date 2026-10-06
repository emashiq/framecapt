import type { Rect } from '../../../shared/rect';

export type { Rect };

/** All geometry in the editor model is in IMAGE PIXELS of the original capture. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Version of the serialized editor document (see model/migrate.ts). 1 = the first editor (arrow,
 * rect, text, redact; no version field); 2 = the professional editor (more elements, styles and
 * the beautify frame). Every field added in version 2 is optional, so a version 1 document is a
 * valid version 2 document.
 */
export const DOC_SCHEMA = 2;

/** An optional drop shadow under a shape. Blur and offset are in image px. */
export interface Shadow {
  blur: number;
  offset: number;
}

/** Fields many elements share. All optional: absent means the element's own default. */
export interface Styled {
  /** 0..1, whole element (default 1). */
  opacity?: number;
  shadow?: Shadow;
}

export type HeadStyle = 'none' | 'triangle' | 'open' | 'dot';
export type ArrowStyle = 'straight' | 'curved';

export interface ArrowAnnotation extends Styled {
  type: 'arrow';
  id: string;
  from: Point;
  /** The arrow head is at `to` (unless `endHead` says otherwise). */
  to: Point;
  color: string;
  /** Stroke width in image px. */
  width: number;
  /** Default 'straight'. */
  style?: ArrowStyle;
  /** Curved only: how far the middle bows to the side, as a fraction of the length (signed). */
  bend?: number;
  /** Default 'none'. */
  startHead?: HeadStyle;
  /** Default 'triangle'. */
  endHead?: HeadStyle;
}

export type DashStyle = 'solid' | 'dashed' | 'dotted';

export interface LineAnnotation extends Styled {
  type: 'line';
  id: string;
  from: Point;
  to: Point;
  color: string;
  width: number;
  dash?: DashStyle;
}

/** A shape drawn inside a rectangle: outline (width 0 = none) and/or a fill. */
export interface ShapeFields extends Styled {
  rect: Rect;
  color: string;
  width: number;
  /** Fill color, absent or null for none. */
  fill?: string | null;
  /** 0..1 (default 1). */
  fillOpacity?: number;
}

export interface RectAnnotation extends ShapeFields {
  type: 'rect';
  id: string;
  /** Corner radius in image px. */
  radius?: number;
}

export interface EllipseAnnotation extends ShapeFields {
  type: 'ellipse';
  id: string;
}

/** A translucent marker over the content (multiply blend), as a rectangle. */
export interface HighlightAnnotation {
  type: 'highlight';
  id: string;
  rect: Rect;
  color: string;
  /** 0..1 (default HIGHLIGHT_OPACITY). */
  opacity?: number;
}

/** Freehand stroke. `highlighter` makes it a wide translucent multiply-blend marker stroke. */
export interface PenAnnotation extends Styled {
  type: 'pen';
  id: string;
  points: Point[];
  color: string;
  width: number;
  highlighter?: boolean;
}

export type BlurMode = 'blur' | 'pixelate';

/**
 * Blurs or pixelates the image under a rectangle. This is a visual effect, NOT a redaction: it
 * can be partly reversed. Use Redact for anything secret.
 */
export interface BlurAnnotation {
  type: 'blur';
  id: string;
  rect: Rect;
  mode: BlurMode;
  /** 1..60: blur radius, or pixelate block size, in image px. */
  amount: number;
}

export interface StepAnnotation extends Styled {
  type: 'step';
  id: string;
  /** Center of the badge. */
  at: Point;
  number: number;
  color: string;
  /** Diameter in image px. */
  size: number;
}

export interface CalloutAnnotation extends Styled {
  type: 'callout';
  id: string;
  rect: Rect;
  /** Where the tail points. */
  tail: Point;
  text: string;
  /** Bubble fill. */
  color: string;
  textColor: string;
  fontSize: number;
  fontWeight: number;
  radius?: number;
}

export type FontFamilyId = 'sans' | 'serif' | 'mono' | 'handwriting';
export type TextAlign = 'left' | 'center' | 'right';

export interface TextAnnotation extends Styled {
  type: 'text';
  id: string;
  /** Top-left of the text box. */
  at: Point;
  text: string;
  color: string;
  /** Font size in image px. */
  fontSize: number;
  fontWeight: number;
  family?: FontFamilyId;
  italic?: boolean;
  align?: TextAlign;
  /** Fill behind the text, absent or null for none. */
  background?: string | null;
  outlineColor?: string | null;
  outlineWidth?: number;
}

/** Dims everything outside the shape. All spotlights of a document share one dim layer. */
export interface SpotlightAnnotation {
  type: 'spotlight';
  id: string;
  rect: Rect;
  shape: 'rect' | 'ellipse';
  /** 0..1 darkness of the dimmed area (default 0.6). */
  dim?: number;
}

/** A zoomed circle: shows the image under it magnified around its own center. */
export interface MagnifierAnnotation extends Styled {
  type: 'magnifier';
  id: string;
  rect: Rect;
  zoom: number;
  color: string;
  width: number;
}

export const STAMP_IDS = [
  'check',
  'cross',
  'star',
  'heart',
  'warning',
  'question',
  'info',
] as const;
export type StampId = (typeof STAMP_IDS)[number];

export interface StampAnnotation extends Styled {
  type: 'stamp';
  id: string;
  at: Point;
  stamp: StampId;
  /** Width and height in image px. */
  size: number;
  color: string;
}

/** A measuring line with end ticks and its length in pixels. */
export interface RulerAnnotation extends Styled {
  type: 'ruler';
  id: string;
  from: Point;
  to: Point;
  color: string;
  width: number;
}

/**
 * A solid opaque cover. It deliberately has NO color and NO opacity field: the export always
 * fills it with #000000 at full alpha, and nothing in the model can express anything else.
 */
export interface RedactAnnotation {
  type: 'redact';
  id: string;
  rect: Rect;
}

export type Annotation =
  | ArrowAnnotation
  | LineAnnotation
  | RectAnnotation
  | EllipseAnnotation
  | HighlightAnnotation
  | PenAnnotation
  | BlurAnnotation
  | StepAnnotation
  | CalloutAnnotation
  | TextAnnotation
  | SpotlightAnnotation
  | MagnifierAnnotation
  | StampAnnotation
  | RulerAnnotation
  | RedactAnnotation;
export type AnnotationType = Annotation['type'];

export const HIGHLIGHT_OPACITY = 0.4;
export const DEFAULT_SPOTLIGHT_DIM = 0.6;

/** The frame around the exported image: a background, padding, rounded corners and a shadow. */
export type BeautifyBackground =
  { kind: 'solid'; color: string } | { kind: 'gradient'; from: string; to: string; angle: number };

export interface Beautify {
  background: BeautifyBackground;
  /** Space between the image and the edge of the export, per side, in image px. */
  padding: number;
  /** Corner radius of the image, in image px. */
  radius: number;
  /** Shadow under the image. */
  shadowBlur: number;
  shadowOffset: number;
  /** 0..1 */
  shadowOpacity: number;
}

export interface EditorDoc {
  /** Size of the original capture in pixels. */
  width: number;
  height: number;
  /** In z-order, first = bottom. Redactions are still drawn above everything at export. */
  annotations: Annotation[];
  /** Non-destructive crop in original image pixels (integers), or null for the whole image. */
  crop: Rect | null;
  /** The frame around the export; absent or null for none (the export is exactly the crop). */
  beautify?: Beautify | null;
}

export function createDoc(width: number, height: number): EditorDoc {
  return { width, height, annotations: [], crop: null };
}

/** True when the export gets a frame (padding, background...). */
export function beautifyActive(doc: EditorDoc): doc is EditorDoc & { beautify: Beautify } {
  return doc.beautify != null && doc.beautify.padding > 0;
}

/** The pixel size of the exported image: the crop (or the whole capture) plus the frame padding. */
export function exportSize(doc: EditorDoc): { width: number; height: number } {
  const pad = beautifyActive(doc) ? doc.beautify.padding * 2 : 0;
  return doc.crop
    ? { width: doc.crop.width + pad, height: doc.crop.height + pad }
    : { width: doc.width + pad, height: doc.height + pad };
}

/** The part of the original that is exported (inside the frame, if any). */
export function exportRect(doc: EditorDoc): Rect {
  return doc.crop ?? { x: 0, y: 0, width: doc.width, height: doc.height };
}

/** Text font stacks. Inter is bundled; the other families are system fonts with fallbacks. */
export const FONT_STACKS: Record<FontFamilyId, string> = {
  sans: '"Inter Variable", Inter, "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  mono: '"Cascadia Mono", Consolas, "SF Mono", "DejaVu Sans Mono", monospace',
  handwriting: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Comic Neue", cursive',
};
export const FONT_LABELS_BY_ID: Record<FontFamilyId, string> = {
  sans: 'Sans',
  serif: 'Serif',
  mono: 'Mono',
  handwriting: 'Hand',
};
/** Font used for text annotations (Inter is bundled; the rest is a fallback chain). */
export const TEXT_FONT_FAMILY = FONT_STACKS.sans;
export const TEXT_LINE_HEIGHT = 1.25;

export function textFont(
  fontSize: number,
  fontWeight: number,
  family: FontFamilyId = 'sans',
  italic = false,
): string {
  return `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px ${FONT_STACKS[family]}`;
}
