import type { Rect } from '../../../shared/rect';

export type { Rect };

/** All geometry in the editor model is in IMAGE PIXELS of the original capture. */
export interface Point {
  x: number;
  y: number;
}

export interface ArrowAnnotation {
  type: 'arrow';
  id: string;
  from: Point;
  /** The arrow head is at `to`. */
  to: Point;
  color: string;
  /** Stroke width in image px. */
  width: number;
}

export interface RectAnnotation {
  type: 'rect';
  id: string;
  rect: Rect;
  color: string;
  width: number;
}

export interface TextAnnotation {
  type: 'text';
  id: string;
  /** Top-left of the text box. */
  at: Point;
  text: string;
  color: string;
  /** Font size in image px. */
  fontSize: number;
  fontWeight: number;
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

export type Annotation = ArrowAnnotation | RectAnnotation | TextAnnotation | RedactAnnotation;
export type AnnotationType = Annotation['type'];

export interface EditorDoc {
  /** Size of the original capture in pixels. */
  width: number;
  height: number;
  /** In z-order, first = bottom. Redactions are still drawn above everything at export. */
  annotations: Annotation[];
  /** Non-destructive crop in original image pixels (integers), or null for the whole image. */
  crop: Rect | null;
}

export function createDoc(width: number, height: number): EditorDoc {
  return { width, height, annotations: [], crop: null };
}

/** The pixel size of the exported image: the crop, or the whole capture. */
export function exportSize(doc: EditorDoc): { width: number; height: number } {
  return doc.crop
    ? { width: doc.crop.width, height: doc.crop.height }
    : { width: doc.width, height: doc.height };
}

/** The part of the original that is exported. */
export function exportRect(doc: EditorDoc): Rect {
  return doc.crop ?? { x: 0, y: 0, width: doc.width, height: doc.height };
}

/** Font used for text annotations (Inter is bundled; the rest is a fallback chain). */
export const TEXT_FONT_FAMILY = '"Inter Variable", Inter, "Segoe UI", system-ui, sans-serif';
export const TEXT_LINE_HEIGHT = 1.25;

export function textFont(fontSize: number, fontWeight: number): string {
  return `${fontWeight} ${fontSize}px ${TEXT_FONT_FAMILY}`;
}
