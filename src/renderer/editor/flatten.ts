import { arrowGeometry } from './model/arrow';
import { exportRect, textFont, TEXT_LINE_HEIGHT } from './model/types';
import type {
  Annotation,
  ArrowAnnotation,
  EditorDoc,
  Rect,
  RectAnnotation,
  TextAnnotation,
} from './model/types';

/**
 * The part of a Canvas 2D context the flattener uses. Both CanvasRenderingContext2D and
 * OffscreenCanvasRenderingContext2D satisfy it, and so does @napi-rs/canvas in the unit tests, so
 * the SAME code that produces the export is exercised against real pixels in Node. Written
 * without DOM types on purpose: this file also compiles in the Node-only test project.
 */
export interface DrawContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: unknown;
  lineJoin: unknown;
  globalAlpha: number;
  globalCompositeOperation: unknown;
  font: string;
  textBaseline: unknown;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  measureText(text: string): {
    width: number;
    fontBoundingBoxAscent?: number;
    fontBoundingBoxDescent?: number;
  };
}

/** Inter's vertical metrics (em), used when the context cannot report font metrics. */
const FALLBACK_ASCENT = 0.969;
const FALLBACK_DESCENT = 0.241;

export function drawArrow(ctx: DrawContext, arrow: ArrowAnnotation): void {
  const geometry = arrowGeometry(arrow.from, arrow.to, arrow.width);
  ctx.save();
  ctx.strokeStyle = arrow.color;
  ctx.fillStyle = arrow.color;
  ctx.lineWidth = arrow.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(arrow.from.x, arrow.from.y);
  ctx.lineTo(geometry.shaftEnd.x, geometry.shaftEnd.y);
  ctx.stroke();
  if (geometry.headLength > 0) {
    ctx.beginPath();
    ctx.moveTo(geometry.tip.x, geometry.tip.y);
    ctx.lineTo(geometry.left.x, geometry.left.y);
    ctx.lineTo(geometry.right.x, geometry.right.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawRect(ctx: DrawContext, annotation: RectAnnotation): void {
  const { rect } = annotation;
  ctx.save();
  ctx.strokeStyle = annotation.color;
  ctx.lineWidth = annotation.width;
  ctx.lineJoin = 'round';
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

/**
 * Text is positioned with the same line box CSS uses (line-height 1.25 em, baseline from the font
 * metrics), so the inline textarea and the pixels agree. Font size is in image pixels.
 */
export function drawText(ctx: DrawContext, annotation: TextAnnotation): void {
  ctx.save();
  ctx.font = textFont(annotation.fontSize, annotation.fontWeight);
  ctx.fillStyle = annotation.color;
  ctx.textBaseline = 'alphabetic';
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent ?? annotation.fontSize * FALLBACK_ASCENT;
  const descent = metrics.fontBoundingBoxDescent ?? annotation.fontSize * FALLBACK_DESCENT;
  const lineHeight = annotation.fontSize * TEXT_LINE_HEIGHT;
  const baselineInLine = (lineHeight - (ascent + descent)) / 2 + ascent;
  annotation.text.split('\n').forEach((line, index) => {
    ctx.fillText(line, annotation.at.x, annotation.at.y + index * lineHeight + baselineInLine);
  });
  ctx.restore();
}

/** Draws every annotation except redactions, in z-order. `skipId` hides one (it is being edited). */
export function drawAnnotations(
  ctx: DrawContext,
  annotations: readonly Annotation[],
  skipId?: string | null,
): void {
  for (const annotation of annotations) {
    if (annotation.id === skipId) continue;
    if (annotation.type === 'arrow') drawArrow(ctx, annotation);
    else if (annotation.type === 'rect') drawRect(ctx, annotation);
    else if (annotation.type === 'text') drawText(ctx, annotation);
  }
}

/**
 * The pixels a redaction really covers: its rectangle snapped OUTWARD to whole pixels and then
 * grown by one more pixel on every side, so no half-blended original pixel can survive at an edge.
 */
export function redactionCoverage(rect: Rect): Rect {
  const x0 = Math.floor(rect.x) - 1;
  const y0 = Math.floor(rect.y) - 1;
  const x1 = Math.ceil(rect.x + rect.width) + 1;
  const y1 = Math.ceil(rect.y + rect.height) + 1;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** JPEG codes 8x8 luma blocks and (4:2:0) 16x16 chroma blocks; chroma is also smoothed with its neighbours. */
export const JPEG_BLOCK = 16;
/** Pixels kept between a redaction and the edge of the black area (chroma upsampling reaches 1 px). */
export const JPEG_MARGIN = 2;

/**
 * JPEG only. Compression smears any hard edge across the 8x8/16x16 blocks it passes through (measured
 * on noise at quality 0.92: up to 37 levels of grey inside a black rectangle, up to 14 px from its
 * edge). To keep every pixel of the user's rectangle exactly black, the cover grows outward to
 * the 16 px block grid of the OUTPUT image plus a 2 px margin: every block that touches the user's
 * rectangle is then entirely black. `origin` is where the output's (0, 0) lies in image pixels.
 */
export function jpegRedactionCoverage(rect: Rect, origin: { x: number; y: number }): Rect {
  const floorTo = (value: number): number => Math.floor(value / JPEG_BLOCK) * JPEG_BLOCK;
  const ceilTo = (value: number): number => Math.ceil(value / JPEG_BLOCK) * JPEG_BLOCK;
  const x0 = floorTo(Math.floor(rect.x) - origin.x - JPEG_MARGIN) + origin.x;
  const y0 = floorTo(Math.floor(rect.y) - origin.y - JPEG_MARGIN) + origin.y;
  const x1 = ceilTo(Math.ceil(rect.x + rect.width) - origin.x + JPEG_MARGIN) + origin.x;
  const y1 = ceilTo(Math.ceil(rect.y + rect.height) - origin.y + JPEG_MARGIN) + origin.y;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Solid #000000 at full alpha, integer-aligned, source-over. Nothing else is ever used. */
export function drawRedactions(
  ctx: DrawContext,
  annotations: readonly Annotation[],
  jpegOrigin?: { x: number; y: number },
): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
  for (const annotation of annotations) {
    if (annotation.type !== 'redact') continue;
    const cover = jpegOrigin
      ? jpegRedactionCoverage(annotation.rect, jpegOrigin)
      : redactionCoverage(annotation.rect);
    ctx.fillRect(cover.x, cover.y, cover.width, cover.height);
  }
  ctx.restore();
}

export interface RenderOptions {
  /** True for the exported raster: the crop is applied and the result starts at (0, 0). */
  forExport: boolean;
  /** Painted under the image first (JPEG has no alpha). */
  background?: string;
  /** The export encoding. JPEG makes redactions cover whole compression blocks (see jpegRedactionCoverage). */
  format?: 'png' | 'jpeg';
  /** Editor only: an annotation that is currently being edited inline and must not be drawn. */
  skipId?: string | null;
}

/**
 * Draws the document. For export the canvas is exactly the crop size: the base image's crop
 * rectangle comes first (drawImage source rect), then the annotations translated by -crop, then
 * ALL redactions last, above everything including text and arrows. A redaction can therefore
 * never be undercut by a later annotation. For the editor view (`forExport: false`) the whole
 * image is drawn in image coordinates (the caller sets the view transform).
 */
export function renderDoc(
  ctx: DrawContext,
  baseImage: unknown,
  doc: EditorDoc,
  options: RenderOptions,
): void {
  const source = options.forExport
    ? exportRect(doc)
    : { x: 0, y: 0, width: doc.width, height: doc.height };
  ctx.save();
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, source.width, source.height);
  }
  if (options.forExport) {
    ctx.drawImage(
      baseImage,
      source.x,
      source.y,
      source.width,
      source.height,
      0,
      0,
      source.width,
      source.height,
    );
    ctx.translate(-source.x, -source.y);
  } else {
    ctx.drawImage(baseImage, 0, 0, doc.width, doc.height, 0, 0, doc.width, doc.height);
  }
  drawAnnotations(ctx, doc.annotations, options.skipId);
  drawRedactions(
    ctx,
    doc.annotations,
    options.forExport && options.format === 'jpeg' ? { x: source.x, y: source.y } : undefined,
  );
  ctx.restore();
}
