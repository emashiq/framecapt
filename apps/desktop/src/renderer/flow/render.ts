import type { FlowStep } from '../../shared/flow';
import { drawPointerRing } from './ring';

/** Exports are drawn at most this wide (a 4K step would make a 200-step export too large to send). */
export const EXPORT_MAX_WIDTH = 2560;

export interface FrameOptions {
  /** The caption banner along the bottom ("Step N" and the caption): images and videos. */
  banner: boolean;
}

/** Breaks `text` into lines no wider than `maxWidth` (the canvas font must be set). */
export function wrapLines(
  ctx: Pick<CanvasRenderingContext2D, 'measureText'>,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawBanner(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  number: number,
  caption: string,
): void {
  const font = Math.max(14, Math.round(width / 54));
  const pad = Math.round(font * 0.9);
  ctx.font = `600 ${font}px system-ui, "Segoe UI", sans-serif`;
  const label = `Step ${number}`;
  const labelWidth = ctx.measureText(label).width;
  const textLeft = pad + labelWidth + pad;
  ctx.font = `500 ${font}px system-ui, "Segoe UI", sans-serif`;
  const lines =
    caption.trim() === '' ? [] : wrapLines(ctx, caption.trim(), width - textLeft - pad).slice(0, 4);
  const lineHeight = Math.round(font * 1.35);
  const bannerHeight = pad * 2 + Math.max(1, lines.length) * lineHeight - (lineHeight - font);
  const top = height - bannerHeight;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fillRect(0, top, width, bannerHeight);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#a5b4fc';
  ctx.font = `700 ${font}px system-ui, "Segoe UI", sans-serif`;
  ctx.fillText(label, pad, top + pad);
  ctx.fillStyle = '#ffffff';
  ctx.font = `500 ${font}px system-ui, "Segoe UI", sans-serif`;
  lines.forEach((line, index) => ctx.fillText(line, textLeft, top + pad + index * lineHeight));
}

/** A step as a PNG: the picture, the pointer ring and (optionally) the caption banner burned in. */
export async function renderStepFrame(
  png: ArrayBuffer,
  step: FlowStep,
  number: number,
  options: FrameOptions,
): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  try {
    const scale = Math.min(1, EXPORT_MAX_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas.');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (step.cursor) drawPointerRing(ctx, step.cursor, bitmap.width, width / bitmap.width);
    if (options.banner) drawBanner(ctx, width, height, number, step.caption);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The picture could not be made.');
    return await blob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}
