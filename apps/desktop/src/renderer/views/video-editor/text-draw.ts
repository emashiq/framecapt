import { MAX_FRAME_DIMENSION } from '../../../shared/shots';
import type { TextItem } from '../../../shared/video-edit';
import { fontOf, wrapLines } from './text-layout';

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Text is drawn by ONE function for the preview and for the export: the preview draws it on the
 * overlay canvas, the export draws it into a transparent PNG as large as the item's box that ffmpeg
 * overlays. What you see is what is exported, with no font or text handling in ffmpeg (the string
 * never leaves the renderer's drawing code and the saved project).
 */

const LINE_HEIGHT = 1.25;

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
};

/**
 * Draws a text item into a context whose origin is the top-left of the item's box and whose unit is
 * one source pixel. `alpha` (0..1) is the item's fade at the time being drawn; the export draws at 1
 * and lets ffmpeg fade the picture.
 */
export function drawTextItem(ctx: Context, item: TextItem, alpha = 1): void {
  const { width, height } = item.rect;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const background = item.background;
  if (background) {
    ctx.fillStyle = rgba(background.color, background.opacity);
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, background.radius);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  const pad = background?.padding ?? 0;
  ctx.font = fontOf(item);
  ctx.textBaseline = 'top';
  ctx.textAlign = item.align;
  ctx.lineJoin = 'round';
  const lines = wrapLines(ctx, item.text, Math.max(1, width - pad * 2));
  const lineHeight = item.size * LINE_HEIGHT;
  const total = lines.length * lineHeight;
  // Centred up and down while it fits; from the top (never above the padding) when it does not.
  const top = Math.max(pad, (height - total) / 2);
  const x = item.align === 'left' ? pad : item.align === 'center' ? width / 2 : width - pad;
  lines.forEach((line, i) => {
    const y = top + i * lineHeight + (lineHeight - item.size) / 2;
    if (item.outline) {
      ctx.save();
      if (item.shadow) shadowOn(ctx, item.size);
      ctx.strokeStyle = item.outline.color;
      ctx.lineWidth = item.outline.width * 2;
      ctx.strokeText(line, x, y);
      ctx.restore();
    }
    ctx.save();
    if (item.shadow && !item.outline) shadowOn(ctx, item.size);
    ctx.fillStyle = item.color;
    ctx.fillText(line, x, y);
    ctx.restore();
  });
  ctx.restore();
}

function shadowOn(ctx: Context, size: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = Math.max(2, size * 0.1);
  ctx.shadowOffsetY = Math.max(1, size * 0.04);
}

/** Waits until the item's font is available to the canvas (the app font loads on first use). */
export async function loadFontFor(item: TextItem): Promise<void> {
  try {
    await document.fonts.load(fontOf(item), item.text);
  } catch {
    // The fallback font in the stack is used.
  }
}

/** The item as a transparent PNG the size of its box: what the export overlays. */
export async function rasterizeText(item: TextItem): Promise<ArrayBuffer> {
  const { width, height } = item.rect;
  if (width > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION || width * height > 80_000_000) {
    throw new Error('The text box is too large.');
  }
  await loadFontFor(item);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context.');
  drawTextItem(ctx, item, 1);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}
