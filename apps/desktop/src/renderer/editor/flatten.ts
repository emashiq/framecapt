import { arrowDraw } from './model/arrow';
import { calloutRadius, calloutTail } from './model/callout';
import {
  DEFAULT_SPOTLIGHT_DIM,
  HIGHLIGHT_OPACITY,
  beautifyActive,
  exportRect,
  exportSize,
  textFont,
  TEXT_LINE_HEIGHT,
  type Annotation,
  type ArrowAnnotation,
  type Beautify,
  type BlurAnnotation,
  type CalloutAnnotation,
  type EditorDoc,
  type EllipseAnnotation,
  type HighlightAnnotation,
  type ImageAnnotation,
  type LineAnnotation,
  type MagnifierAnnotation,
  type PenAnnotation,
  type Point,
  type Rect,
  type RectAnnotation,
  type RulerAnnotation,
  type Shadow,
  type SpotlightAnnotation,
  type StampAnnotation,
  type StepAnnotation,
  type TextAnnotation,
} from './model/types';
import { readableOn } from './presets';

/** A gradient the context hands out. */
export interface GradientLike {
  addColorStop(offset: number, color: string): void;
}

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
  textAlign: unknown;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  imageSmoothingEnabled: boolean;
  filter: string;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
  ): void;
  rect(x: number, y: number, width: number, height: number): void;
  closePath(): void;
  clip(rule?: 'nonzero' | 'evenodd'): void;
  fill(rule?: 'nonzero' | 'evenodd'): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike;
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

/** A canvas the flattener can draw effect regions on. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}
export type CanvasFactory = (width: number, height: number) => CanvasLike;

/** Blurred and pixelated regions, keyed by what they depend on, so a redraw never recomputes them. */
export type EffectCache = Map<string, CanvasLike>;
/** More regions than this are dropped oldest first (each is a canvas of its region's size). */
const EFFECT_CACHE_LIMIT = 24;

/** A decoded picture an image layer draws: a canvas image source and its size in pixels. */
export interface DrawAsset {
  image: unknown;
  width: number;
  height: number;
}

/** What the elements that read the base image (blur, magnifier), image layers and the shadows need. */
export interface DrawEnv {
  /** The base image the document was made from, and its size. */
  base: unknown;
  baseWidth: number;
  baseHeight: number;
  createCanvas: CanvasFactory | undefined;
  cache?: EffectCache | undefined;
  /**
   * Device pixels per image pixel. Canvas shadows are NOT scaled by the transform, so they are
   * multiplied by this to stay the same size relative to the picture at any zoom.
   */
  shadowScale: number;
  /** The pictures of image layers by asset id. A layer whose picture is missing draws a placeholder. */
  assets?: ReadonlyMap<string, DrawAsset> | undefined;
}

/** Inter's vertical metrics (em), used when the context cannot report font metrics. */
const FALLBACK_ASCENT = 0.969;
const FALLBACK_DESCENT = 0.241;

const SHADOW_COLOR = 'rgba(0, 0, 0, 0.45)';

function defaultCanvasFactory(): CanvasFactory | undefined {
  const Offscreen = (
    globalThis as { OffscreenCanvas?: new (width: number, height: number) => CanvasLike }
  ).OffscreenCanvas;
  return Offscreen ? (width, height) => new Offscreen(width, height) : undefined;
}

function setShadow(ctx: DrawContext, shadow: Shadow | undefined, scale: number): void {
  if (!shadow || (shadow.blur <= 0 && shadow.offset === 0)) return;
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = shadow.blur * scale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = shadow.offset * scale;
}

function clearShadow(ctx: DrawContext): void {
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function roundedRectPath(ctx: DrawContext, rect: Rect, radius: number): void {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const { x, y, width, height } = rect;
  ctx.beginPath();
  if (r === 0) {
    ctx.rect(x, y, width, height);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function ellipsePath(ctx: DrawContext, rect: Rect): void {
  ctx.beginPath();
  ctx.ellipse(
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    Math.max(rect.width / 2, 0),
    Math.max(rect.height / 2, 0),
    0,
    0,
    Math.PI * 2,
  );
  ctx.closePath();
}

function applyDash(ctx: DrawContext, dash: LineAnnotation['dash'], width: number): void {
  if (dash === 'dashed') ctx.setLineDash([width * 3, width * 2]);
  else if (dash === 'dotted') {
    ctx.setLineDash([0.01, width * 2]);
    ctx.lineCap = 'round';
  } else ctx.setLineDash([]);
}

export function drawArrow(ctx: DrawContext, arrow: ArrowAnnotation, env?: DrawEnv): void {
  const draw = arrowDraw(arrow);
  ctx.save();
  ctx.globalAlpha = arrow.opacity ?? 1;
  setShadow(ctx, arrow.shadow, env?.shadowScale ?? 1);
  ctx.strokeStyle = arrow.color;
  ctx.fillStyle = arrow.color;
  ctx.lineWidth = arrow.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(draw.from.x, draw.from.y);
  if (draw.control) ctx.quadraticCurveTo(draw.control.x, draw.control.y, draw.to.x, draw.to.y);
  else ctx.lineTo(draw.to.x, draw.to.y);
  ctx.stroke();
  for (const head of [draw.start, draw.end]) {
    if (!head) continue;
    const g = head.geometry;
    if (head.style === 'dot') {
      ctx.beginPath();
      ctx.ellipse(g.tip.x, g.tip.y, head.dotRadius, head.dotRadius, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (g.headLength > 0 && head.style === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(g.tip.x, g.tip.y);
      ctx.lineTo(g.left.x, g.left.y);
      ctx.lineTo(g.right.x, g.right.y);
      ctx.closePath();
      ctx.fill();
    } else if (g.headLength > 0 && head.style === 'open') {
      ctx.beginPath();
      ctx.moveTo(g.left.x, g.left.y);
      ctx.lineTo(g.tip.x, g.tip.y);
      ctx.lineTo(g.right.x, g.right.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawLine(ctx: DrawContext, line: LineAnnotation, env?: DrawEnv): void {
  ctx.save();
  ctx.globalAlpha = line.opacity ?? 1;
  setShadow(ctx, line.shadow, env?.shadowScale ?? 1);
  ctx.strokeStyle = line.color;
  ctx.lineWidth = line.width;
  ctx.lineCap = 'round';
  applyDash(ctx, line.dash, line.width);
  ctx.beginPath();
  ctx.moveTo(line.from.x, line.from.y);
  ctx.lineTo(line.to.x, line.to.y);
  ctx.stroke();
  ctx.restore();
}

/** Fill, then outline. The shadow belongs to the first thing painted so it is not drawn twice. */
function paintShape(
  ctx: DrawContext,
  shape: RectAnnotation | EllipseAnnotation,
  path: () => void,
  env?: DrawEnv,
): void {
  const filled = (shape.fill ?? null) !== null && (shape.fillOpacity ?? 1) > 0;
  const stroked = shape.width > 0;
  ctx.save();
  ctx.globalAlpha = shape.opacity ?? 1;
  const scale = env?.shadowScale ?? 1;
  if (filled) {
    ctx.save();
    ctx.globalAlpha = (shape.opacity ?? 1) * (shape.fillOpacity ?? 1);
    setShadow(ctx, shape.shadow, scale);
    ctx.fillStyle = shape.fill as string;
    path();
    ctx.fill();
    ctx.restore();
  }
  if (stroked) {
    ctx.save();
    if (!filled) setShadow(ctx, shape.shadow, scale);
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.width;
    ctx.lineJoin = 'round';
    path();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

export function drawRect(ctx: DrawContext, annotation: RectAnnotation, env?: DrawEnv): void {
  const { rect } = annotation;
  const radius = annotation.radius ?? 0;
  if (radius <= 0 && (annotation.fill ?? null) === null) {
    // The original rectangle: an outline only, drawn exactly as before.
    ctx.save();
    ctx.globalAlpha = annotation.opacity ?? 1;
    setShadow(ctx, annotation.shadow, env?.shadowScale ?? 1);
    ctx.strokeStyle = annotation.color;
    ctx.lineWidth = annotation.width;
    ctx.lineJoin = 'round';
    if (annotation.width > 0) ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    return;
  }
  paintShape(ctx, annotation, () => roundedRectPath(ctx, rect, radius), env);
}

export function drawEllipse(ctx: DrawContext, annotation: EllipseAnnotation, env?: DrawEnv): void {
  paintShape(ctx, annotation, () => ellipsePath(ctx, annotation.rect), env);
}

export function drawHighlight(ctx: DrawContext, annotation: HighlightAnnotation): void {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = annotation.opacity ?? HIGHLIGHT_OPACITY;
  ctx.fillStyle = annotation.color;
  ctx.fillRect(annotation.rect.x, annotation.rect.y, annotation.rect.width, annotation.rect.height);
  ctx.restore();
}

/** A smooth path through the points: quadratic curves between midpoints. */
function smoothPath(ctx: DrawContext, points: readonly Point[]): void {
  const first = points[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  if (points.length === 1) {
    ctx.lineTo(first.x + 0.01, first.y);
    return;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i] as Point;
    const next = points[i + 1] as Point;
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  const last = points[points.length - 1] as Point;
  ctx.lineTo(last.x, last.y);
}

export function drawPen(ctx: DrawContext, pen: PenAnnotation, env?: DrawEnv): void {
  ctx.save();
  if (pen.highlighter) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = pen.opacity ?? HIGHLIGHT_OPACITY;
    ctx.lineCap = 'square';
  } else {
    ctx.globalAlpha = pen.opacity ?? 1;
    setShadow(ctx, pen.shadow, env?.shadowScale ?? 1);
    ctx.lineCap = 'round';
  }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = pen.color;
  ctx.lineWidth = pen.width;
  smoothPath(ctx, pen.points);
  ctx.stroke();
  ctx.restore();
}

/**
 * The text of an annotation in the line box CSS uses (line-height 1.25 em, baseline from the font
 * metrics), so the inline textarea and the pixels agree. Font size is in image pixels.
 */
function textMetrics(ctx: DrawContext, fontSize: number) {
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent ?? fontSize * FALLBACK_ASCENT;
  const descent = metrics.fontBoundingBoxDescent ?? fontSize * FALLBACK_DESCENT;
  const lineHeight = fontSize * TEXT_LINE_HEIGHT;
  return { lineHeight, baselineInLine: (lineHeight - (ascent + descent)) / 2 + ascent };
}

export function drawText(ctx: DrawContext, annotation: TextAnnotation, env?: DrawEnv): void {
  ctx.save();
  ctx.globalAlpha = annotation.opacity ?? 1;
  ctx.font = textFont(
    annotation.fontSize,
    annotation.fontWeight,
    annotation.family ?? 'sans',
    annotation.italic ?? false,
  );
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const { lineHeight, baselineInLine } = textMetrics(ctx, annotation.fontSize);
  const lines = annotation.text.split('\n');
  const widths = lines.map((line) => ctx.measureText(line).width);
  const boxWidth = Math.max(annotation.fontSize * 0.5, ...widths);
  const boxHeight = lines.length * lineHeight;
  const scale = env?.shadowScale ?? 1;
  const hasBackground = (annotation.background ?? null) !== null;
  if (hasBackground) {
    const pad = Math.round(annotation.fontSize * 0.25);
    ctx.save();
    setShadow(ctx, annotation.shadow, scale);
    ctx.fillStyle = annotation.background as string;
    roundedRectPath(
      ctx,
      {
        x: annotation.at.x - pad,
        y: annotation.at.y - pad / 2,
        width: boxWidth + 2 * pad,
        height: boxHeight + pad,
      },
      pad,
    );
    ctx.fill();
    ctx.restore();
  }
  const outline = (annotation.outlineWidth ?? 0) > 0 && (annotation.outlineColor ?? null) !== null;
  const factor = annotation.align === 'center' ? 0.5 : annotation.align === 'right' ? 1 : 0;
  lines.forEach((line, index) => {
    const x = annotation.at.x + (boxWidth - (widths[index] ?? 0)) * factor;
    const y = annotation.at.y + index * lineHeight + baselineInLine;
    if (outline) {
      ctx.save();
      ctx.strokeStyle = annotation.outlineColor as string;
      ctx.lineWidth = (annotation.outlineWidth as number) * 2;
      ctx.lineJoin = 'round';
      if (!hasBackground) setShadow(ctx, annotation.shadow, scale);
      ctx.strokeText(line, x, y);
      ctx.restore();
    }
    ctx.save();
    if (!hasBackground && !outline) setShadow(ctx, annotation.shadow, scale);
    ctx.fillStyle = annotation.color;
    ctx.fillText(line, x, y);
    ctx.restore();
  });
  ctx.restore();
}

export function drawCallout(ctx: DrawContext, annotation: CalloutAnnotation, env?: DrawEnv): void {
  const { rect } = annotation;
  const radius = calloutRadius(annotation);
  const tail = calloutTail(rect, annotation.tail, radius);
  ctx.save();
  ctx.globalAlpha = annotation.opacity ?? 1;
  setShadow(ctx, annotation.shadow, env?.shadowScale ?? 1);
  ctx.fillStyle = annotation.color;
  if (tail) {
    ctx.beginPath();
    ctx.moveTo(tail.a.x, tail.a.y);
    ctx.lineTo(tail.tip.x, tail.tip.y);
    ctx.lineTo(tail.b.x, tail.b.y);
    ctx.closePath();
    ctx.fill();
  }
  roundedRectPath(ctx, rect, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = annotation.opacity ?? 1;
  ctx.font = textFont(annotation.fontSize, annotation.fontWeight);
  ctx.fillStyle = annotation.textColor;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  const { lineHeight, baselineInLine } = textMetrics(ctx, annotation.fontSize);
  const lines = annotation.text.split('\n');
  const top = rect.y + (rect.height - lines.length * lineHeight) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, rect.x + rect.width / 2, top + index * lineHeight + baselineInLine);
  });
  ctx.restore();
}

export function drawStep(ctx: DrawContext, annotation: StepAnnotation, env?: DrawEnv): void {
  const r = annotation.size / 2;
  ctx.save();
  ctx.globalAlpha = annotation.opacity ?? 1;
  setShadow(ctx, annotation.shadow, env?.shadowScale ?? 1);
  ctx.fillStyle = annotation.color;
  ctx.beginPath();
  ctx.ellipse(annotation.at.x, annotation.at.y, r, r, 0, 0, Math.PI * 2);
  ctx.fill();
  clearShadow(ctx);
  const label = String(annotation.number);
  const fontSize = (annotation.size * (label.length > 2 ? 0.4 : label.length > 1 ? 0.5 : 0.58)) | 0;
  ctx.font = textFont(Math.max(fontSize, 6), 700);
  ctx.fillStyle = readableOn(annotation.color);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const { baselineInLine, lineHeight } = textMetrics(ctx, Math.max(fontSize, 6));
  ctx.fillText(label, annotation.at.x, annotation.at.y - lineHeight / 2 + baselineInLine);
  ctx.restore();
}

export function drawStamp(ctx: DrawContext, annotation: StampAnnotation, env?: DrawEnv): void {
  const { at, size } = annotation;
  const r = size / 2;
  const u = size / 24; // the glyphs are drawn on a 24 x 24 grid centered on `at`
  const p = (x: number, y: number): [number, number] => [at.x + (x - 12) * u, at.y + (y - 12) * u];
  ctx.save();
  ctx.globalAlpha = annotation.opacity ?? 1;
  setShadow(ctx, annotation.shadow, env?.shadowScale ?? 1);
  ctx.fillStyle = annotation.color;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2.4 * u, 1);
  const badge = (): void => {
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, r, r, 0, 0, Math.PI * 2);
    ctx.fill();
    clearShadow(ctx);
  };
  const glyph = (draw: () => void): void => {
    ctx.beginPath();
    draw();
    ctx.stroke();
  };
  switch (annotation.stamp) {
    case 'check':
      badge();
      glyph(() => {
        ctx.moveTo(...p(6.5, 12.5));
        ctx.lineTo(...p(10.5, 16.5));
        ctx.lineTo(...p(17.5, 8));
      });
      break;
    case 'cross':
      badge();
      glyph(() => {
        ctx.moveTo(...p(8, 8));
        ctx.lineTo(...p(16, 16));
        ctx.moveTo(...p(16, 8));
        ctx.lineTo(...p(8, 16));
      });
      break;
    case 'star': {
      ctx.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? r : r * 0.42;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = at.x + Math.cos(angle) * radius;
        const y = at.y + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'heart':
      ctx.beginPath();
      ctx.moveTo(...p(12, 21));
      ctx.bezierCurveTo(...p(3, 14), ...p(1.5, 8), ...p(5.5, 4.8));
      ctx.bezierCurveTo(...p(8.5, 2.6), ...p(11, 4.2), ...p(12, 6.5));
      ctx.bezierCurveTo(...p(13, 4.2), ...p(15.5, 2.6), ...p(18.5, 4.8));
      ctx.bezierCurveTo(...p(22.5, 8), ...p(21, 14), ...p(12, 21));
      ctx.closePath();
      ctx.fill();
      break;
    case 'warning':
      ctx.beginPath();
      ctx.moveTo(...p(12, 2.5));
      ctx.lineTo(...p(22.5, 20.5));
      ctx.lineTo(...p(1.5, 20.5));
      ctx.closePath();
      ctx.fill();
      clearShadow(ctx);
      glyph(() => {
        ctx.moveTo(...p(12, 9));
        ctx.lineTo(...p(12, 14.5));
        ctx.moveTo(...p(12, 17.4));
        ctx.lineTo(...p(12, 17.5));
      });
      break;
    case 'question':
    case 'info': {
      badge();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = textFont(Math.round(size * 0.62), 800);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const { baselineInLine, lineHeight } = textMetrics(ctx, Math.round(size * 0.62));
      ctx.fillText(
        annotation.stamp === 'question' ? '?' : 'i',
        at.x,
        at.y - lineHeight / 2 + baselineInLine,
      );
      break;
    }
  }
  ctx.restore();
}

export function drawRuler(ctx: DrawContext, ruler: RulerAnnotation, env?: DrawEnv): void {
  const dx = ruler.to.x - ruler.from.x;
  const dy = ruler.to.y - ruler.from.y;
  const length = Math.hypot(dx, dy);
  ctx.save();
  ctx.globalAlpha = ruler.opacity ?? 1;
  setShadow(ctx, ruler.shadow, env?.shadowScale ?? 1);
  ctx.strokeStyle = ruler.color;
  ctx.lineWidth = ruler.width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ruler.from.x, ruler.from.y);
  ctx.lineTo(ruler.to.x, ruler.to.y);
  if (length > 0) {
    const tick = Math.max(8, ruler.width * 3);
    const nx = (-dy / length) * tick;
    const ny = (dx / length) * tick;
    for (const end of [ruler.from, ruler.to]) {
      ctx.moveTo(end.x - nx, end.y - ny);
      ctx.lineTo(end.x + nx, end.y + ny);
    }
  }
  ctx.stroke();
  clearShadow(ctx);
  const fontSize = Math.max(12, Math.round(ruler.width * 3.5));
  const label = `${Math.round(length)} px`;
  ctx.font = textFont(fontSize, 600);
  const labelWidth = ctx.measureText(label).width;
  const pad = fontSize * 0.4;
  const cx = (ruler.from.x + ruler.to.x) / 2;
  const cy = (ruler.from.y + ruler.to.y) / 2;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  roundedRectPath(
    ctx,
    {
      x: cx - labelWidth / 2 - pad,
      y: cy - fontSize * 0.7 - pad / 2,
      width: labelWidth + 2 * pad,
      height: fontSize * 1.4 + pad,
    },
    fontSize * 0.5,
  );
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const { baselineInLine, lineHeight } = textMetrics(ctx, fontSize);
  ctx.fillText(label, cx, cy - lineHeight / 2 + baselineInLine);
  ctx.restore();
}

/**
 * An image layer: the picture stretched to its rectangle, with rounded corners, opacity and a drop
 * shadow. The shadow comes from an opaque caster drawn far off to the side whose shadow is offset
 * back, so the caster itself never shows (the same trick as the frame's shadow). A layer whose
 * picture is missing draws a neutral crossed box instead.
 */
export function drawImageLayer(ctx: DrawContext, layer: ImageAnnotation, env?: DrawEnv): void {
  const { rect } = layer;
  if (rect.width <= 0 || rect.height <= 0) return;
  const radius = layer.radius ?? 0;
  const asset = env?.assets?.get(layer.assetId);
  ctx.save();
  ctx.globalAlpha = layer.opacity ?? 1;
  const shadow = layer.shadow;
  if (shadow && (shadow.blur > 0 || shadow.offset !== 0)) {
    const scale = env?.shadowScale ?? 1;
    const away = rect.x + rect.width + 4 * shadow.blur + 1000;
    ctx.save();
    ctx.shadowColor = SHADOW_COLOR;
    ctx.shadowBlur = shadow.blur * scale;
    ctx.shadowOffsetX = away * scale;
    ctx.shadowOffsetY = shadow.offset * scale;
    ctx.fillStyle = '#000000';
    roundedRectPath(ctx, { ...rect, x: rect.x - away }, radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundedRectPath(ctx, rect, radius);
  ctx.clip();
  if (asset) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      asset.image,
      0,
      0,
      asset.width,
      asset.height,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    );
  } else {
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = Math.max(1, Math.min(rect.width, rect.height) / 40);
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y);
    ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
    ctx.moveTo(rect.x + rect.width, rect.y);
    ctx.lineTo(rect.x, rect.y + rect.height);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

// --- effects that read the base image ------------------------------------------------------------

/** drawImage of a source rectangle that may reach outside the image: the outside part is skipped. */
function drawImageClamped(
  ctx: DrawContext,
  env: DrawEnv,
  source: Rect,
  dest: Rect,
  image: unknown = env.base,
  imageWidth = env.baseWidth,
  imageHeight = env.baseHeight,
): void {
  const x0 = Math.max(0, source.x);
  const y0 = Math.max(0, source.y);
  const x1 = Math.min(imageWidth, source.x + source.width);
  const y1 = Math.min(imageHeight, source.y + source.height);
  if (x1 <= x0 || y1 <= y0 || source.width <= 0 || source.height <= 0) return;
  const kx = dest.width / source.width;
  const ky = dest.height / source.height;
  ctx.drawImage(
    image,
    x0,
    y0,
    x1 - x0,
    y1 - y0,
    dest.x + (x0 - source.x) * kx,
    dest.y + (y0 - source.y) * ky,
    (x1 - x0) * kx,
    (y1 - y0) * ky,
  );
}

/** The whole-pixel region of the image a blur covers. */
function effectRegion(rect: Rect, env: DrawEnv): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(env.baseWidth, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(env.baseHeight, Math.ceil(rect.y + rect.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function buildEffect(annotation: BlurAnnotation, region: Rect, env: DrawEnv): CanvasLike | null {
  const create = env.createCanvas ?? defaultCanvasFactory();
  if (!create) return null;
  const out = create(region.width, region.height);
  const octx = out.getContext('2d') as DrawContext | null;
  if (!octx) return null;
  const amount = Math.max(1, Math.round(annotation.amount));
  if (annotation.mode === 'pixelate') {
    const block = Math.max(2, amount);
    const cols = Math.max(1, Math.ceil(region.width / block));
    const rows = Math.max(1, Math.ceil(region.height / block));
    const small = create(cols, rows);
    const sctx = small.getContext('2d') as DrawContext | null;
    if (!sctx) return null;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(env.base, region.x, region.y, region.width, region.height, 0, 0, cols, rows);
    octx.imageSmoothingEnabled = false;
    octx.drawImage(small, 0, 0, cols, rows, 0, 0, cols * block, rows * block);
    return out;
  }
  // Blur: the neighbourhood around the region is read too, so the edges do not fade out.
  const reach = Math.min(amount * 3, 200);
  const source = {
    x: region.x - reach,
    y: region.y - reach,
    width: region.width + 2 * reach,
    height: region.height + 2 * reach,
  };
  const dest = { x: -reach, y: -reach, width: source.width, height: source.height };
  octx.imageSmoothingEnabled = true;
  if (typeof octx.filter === 'string') {
    octx.filter = `blur(${amount}px)`;
    drawImageClamped(octx, env, source, dest);
    octx.filter = 'none';
  } else {
    // No filter support: shrink and stretch back (smooth, deterministic, cheap).
    const factor = Math.max(1, amount);
    const small = create(
      Math.max(1, Math.ceil(region.width / factor)),
      Math.max(1, Math.ceil(region.height / factor)),
    );
    const sctx = small.getContext('2d') as DrawContext | null;
    if (!sctx) return null;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(
      env.base,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      small.width,
      small.height,
    );
    octx.drawImage(small, 0, 0, small.width, small.height, 0, 0, region.width, region.height);
  }
  return out;
}

export function drawBlur(ctx: DrawContext, annotation: BlurAnnotation, env?: DrawEnv): void {
  if (!env) return;
  const region = effectRegion(annotation.rect, env);
  if (!region) return;
  const key = [
    annotation.id,
    annotation.mode,
    Math.round(annotation.amount),
    region.x,
    region.y,
    region.width,
    region.height,
  ].join('|');
  let canvas = env.cache?.get(key);
  if (!canvas) {
    canvas = buildEffect(annotation, region, env) ?? undefined;
    if (!canvas) return;
    if (env.cache) {
      env.cache.set(key, canvas);
      while (env.cache.size > EFFECT_CACHE_LIMIT) {
        const oldest = env.cache.keys().next().value;
        if (oldest === undefined) break;
        env.cache.delete(oldest);
      }
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(region.x, region.y, region.width, region.height);
  ctx.clip();
  ctx.drawImage(
    canvas,
    0,
    0,
    canvas.width,
    canvas.height,
    region.x,
    region.y,
    region.width,
    region.height,
  );
  ctx.restore();
}

export function drawMagnifier(
  ctx: DrawContext,
  annotation: MagnifierAnnotation,
  env?: DrawEnv,
): void {
  if (!env) return;
  const { rect } = annotation;
  if (rect.width <= 0 || rect.height <= 0) return;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const sw = rect.width / annotation.zoom;
  const sh = rect.height / annotation.zoom;
  ctx.save();
  ctx.globalAlpha = annotation.opacity ?? 1;
  // The shadow is cast by the disc itself, under the picture.
  if (annotation.shadow) {
    ctx.save();
    setShadow(ctx, annotation.shadow, env.shadowScale);
    ctx.fillStyle = '#000000';
    ellipsePath(ctx, rect);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ellipsePath(ctx, rect);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  drawImageClamped(ctx, env, { x: cx - sw / 2, y: cy - sh / 2, width: sw, height: sh }, rect);
  ctx.restore();
  if (annotation.width > 0) {
    ctx.strokeStyle = annotation.color;
    ctx.lineWidth = annotation.width;
    ellipsePath(ctx, rect);
    ctx.stroke();
  }
  ctx.restore();
}

/** One dim layer with a hole for every spotlight (the first one's darkness). */
function drawSpotlights(
  ctx: DrawContext,
  spotlights: readonly SpotlightAnnotation[],
  area: Rect,
): void {
  const first = spotlights[0];
  if (!first) return;
  ctx.save();
  // Each spotlight clips away its own shape; the clips intersect, so the layer covers the area
  // outside ALL shapes, whatever overlaps.
  for (const spot of spotlights) {
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.width, area.height);
    if (spot.shape === 'ellipse') {
      ctx.ellipse(
        spot.rect.x + spot.rect.width / 2,
        spot.rect.y + spot.rect.height / 2,
        Math.max(spot.rect.width / 2, 0),
        Math.max(spot.rect.height / 2, 0),
        0,
        0,
        Math.PI * 2,
      );
    } else {
      ctx.rect(spot.rect.x, spot.rect.y, spot.rect.width, spot.rect.height);
    }
    ctx.clip('evenodd');
  }
  ctx.fillStyle = `rgba(0, 0, 0, ${first.dim ?? DEFAULT_SPOTLIGHT_DIM})`;
  ctx.fillRect(area.x, area.y, area.width, area.height);
  ctx.restore();
}

/**
 * Draws every annotation except redactions, in z-order. `skipId` hides one (it is being edited).
 * Without `env` the elements that read the base image (blur, magnifier) are skipped.
 */
export function drawAnnotations(
  ctx: DrawContext,
  annotations: readonly Annotation[],
  skipId?: string | null,
  env?: DrawEnv,
): void {
  const spotlights = annotations.filter(
    (annotation): annotation is SpotlightAnnotation =>
      annotation.type === 'spotlight' && annotation.id !== skipId,
  );
  const area: Rect = env
    ? { x: 0, y: 0, width: env.baseWidth, height: env.baseHeight }
    : { x: -1e5, y: -1e5, width: 2e5, height: 2e5 };
  let spotlightsDrawn = false;
  for (const annotation of annotations) {
    if (annotation.id === skipId) continue;
    switch (annotation.type) {
      case 'arrow':
        drawArrow(ctx, annotation, env);
        break;
      case 'line':
        drawLine(ctx, annotation, env);
        break;
      case 'rect':
        drawRect(ctx, annotation, env);
        break;
      case 'ellipse':
        drawEllipse(ctx, annotation, env);
        break;
      case 'highlight':
        drawHighlight(ctx, annotation);
        break;
      case 'pen':
        drawPen(ctx, annotation, env);
        break;
      case 'blur':
        drawBlur(ctx, annotation, env);
        break;
      case 'step':
        drawStep(ctx, annotation, env);
        break;
      case 'callout':
        drawCallout(ctx, annotation, env);
        break;
      case 'text':
        drawText(ctx, annotation, env);
        break;
      case 'spotlight':
        if (!spotlightsDrawn) {
          spotlightsDrawn = true;
          drawSpotlights(ctx, spotlights, area);
        }
        break;
      case 'magnifier':
        drawMagnifier(ctx, annotation, env);
        break;
      case 'stamp':
        drawStamp(ctx, annotation, env);
        break;
      case 'ruler':
        drawRuler(ctx, annotation, env);
        break;
      case 'image':
        drawImageLayer(ctx, annotation, env);
        break;
      case 'redact':
        break; // drawn last, above everything (drawRedactions)
    }
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
  clearShadow(ctx);
  ctx.filter = 'none';
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
  /** Makes the canvases blur and pixelate regions are drawn on (default: OffscreenCanvas). */
  createCanvas?: CanvasFactory;
  /** Editor only: keeps blur and pixelate regions between redraws. */
  cache?: EffectCache;
  /** Editor only: device pixels per image pixel (shadows follow the zoom). Default 1. */
  shadowScale?: number;
  /** The pictures of the document's image layers, by asset id. */
  assets?: ReadonlyMap<string, DrawAsset>;
}

function drawFrameBackground(ctx: DrawContext, beautify: Beautify, width: number, height: number) {
  const { background } = beautify;
  if (background.kind === 'solid') {
    ctx.fillStyle = background.color;
  } else {
    // CSS angles: 0 deg points up, 90 deg right.
    const angle = (background.angle * Math.PI) / 180;
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const length = Math.abs(width * dx) + Math.abs(height * dy);
    const gradient = ctx.createLinearGradient(
      width / 2 - (dx * length) / 2,
      height / 2 - (dy * length) / 2,
      width / 2 + (dx * length) / 2,
      height / 2 + (dy * length) / 2,
    );
    gradient.addColorStop(0, background.from);
    gradient.addColorStop(1, background.to);
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
}

/**
 * Draws the document. For export the canvas is exactly `exportSize(doc)`: the crop plus the frame
 * (background, padding, rounded image, shadow) when beautify is on. The base image's crop
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
  const env: DrawEnv = {
    base: baseImage,
    baseWidth: doc.width,
    baseHeight: doc.height,
    createCanvas: options.createCanvas ?? defaultCanvasFactory(),
    cache: options.cache,
    shadowScale: options.shadowScale ?? 1,
    assets: options.assets,
  };
  ctx.save();
  const framed = options.forExport && beautifyActive(doc);
  const frame = framed ? doc.beautify : null;
  const padding = frame ? frame.padding : 0;
  const out = exportSize(doc);
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  if (frame) {
    drawFrameBackground(ctx, frame, out.width, out.height);
    ctx.translate(padding, padding);
    const area: Rect = { x: 0, y: 0, width: source.width, height: source.height };
    if (frame.shadowBlur > 0 || frame.shadowOffset !== 0) {
      // The shadow of the image: its caster is drawn far off to the side and the shadow offset
      // brings the shadow back, so the caster itself never shows.
      const away = out.width + out.height + 4 * frame.shadowBlur + 1000;
      ctx.save();
      ctx.shadowColor = `rgba(0, 0, 0, ${frame.shadowOpacity})`;
      ctx.shadowBlur = frame.shadowBlur * env.shadowScale;
      ctx.shadowOffsetX = away * env.shadowScale;
      ctx.shadowOffsetY = frame.shadowOffset * env.shadowScale;
      ctx.fillStyle = '#000000';
      roundedRectPath(ctx, { ...area, x: area.x - away }, frame.radius);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    roundedRectPath(ctx, area, frame.radius);
    ctx.clip();
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
  drawAnnotations(ctx, doc.annotations, options.skipId, env);
  if (frame) {
    // Leave the rounded clip: redactions are never clipped (they only ever cover more).
    ctx.restore();
    ctx.translate(-source.x, -source.y);
  }
  drawRedactions(
    ctx,
    doc.annotations,
    options.forExport && options.format === 'jpeg'
      ? { x: source.x - padding, y: source.y - padding }
      : undefined,
  );
  ctx.restore();
}
