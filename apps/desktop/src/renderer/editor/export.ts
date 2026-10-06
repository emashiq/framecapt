import { renderDoc, type DrawContext } from './flatten';
import { exportSize, textFont, type EditorDoc } from './model/types';
import type { ImageFormat } from '../../shared/shots';

/** JPEG quality used for exports. */
export const JPEG_QUALITY = 0.92;

export const THUMBNAIL_MAX_WIDTH = 480;

/**
 * Makes sure the text annotations' font is loaded before anything is drawn with it (an
 * OffscreenCanvas silently uses a fallback font otherwise, and the export would not match the
 * editor).
 */
export async function loadEditorFonts(doc: EditorDoc): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  // One load per font actually used (family, weight, italic) and the text drawn in it. Elements
  // with their own labels (step numbers, stamps, rulers, callouts) use the bundled sans family.
  const wanted = new Map<string, string>();
  const want = (font: string, text: string): void => {
    wanted.set(font, (wanted.get(font) ?? '') + text);
  };
  for (const annotation of doc.annotations) {
    if (annotation.type === 'text') {
      want(
        textFont(
          16,
          annotation.fontWeight,
          annotation.family ?? 'sans',
          annotation.italic ?? false,
        ),
        annotation.text,
      );
    } else if (annotation.type === 'callout') {
      want(textFont(16, annotation.fontWeight), annotation.text);
    } else if (annotation.type === 'step') {
      want(textFont(16, 700), '0123456789');
    } else if (annotation.type === 'stamp') {
      want(textFont(16, 800), '?i');
    } else if (annotation.type === 'ruler') {
      want(textFont(16, 600), '0123456789 px');
    }
  }
  await Promise.all([...wanted].map(([font, text]) => document.fonts.load(font, text)));
}

function newCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
}

/**
 * The flattened result as a canvas: exactly the crop size (or the whole image), never scaled by
 * the editor zoom or devicePixelRatio. Redactions are solid #000 pixels in this raster.
 */
export async function flattenToCanvas(
  baseImage: ImageBitmap,
  doc: EditorDoc,
  format: ImageFormat = 'png',
): Promise<OffscreenCanvas> {
  await loadEditorFonts(doc);
  const { width, height } = exportSize(doc);
  const canvas = newCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a 2D canvas context.');
  renderDoc(context as unknown as DrawContext, baseImage, doc, {
    forExport: true,
    format,
    ...(format === 'jpeg' && { background: '#ffffff' }),
  });
  return canvas;
}

/** PNG, or JPEG at `quality`, of the flattened document. This is what Save and Copy send to main. */
export async function flattenToBlob(
  baseImage: ImageBitmap,
  doc: EditorDoc,
  format: ImageFormat,
  quality: number = JPEG_QUALITY,
): Promise<Blob> {
  const canvas = await flattenToCanvas(baseImage, doc, format);
  return canvas.convertToBlob(
    format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality },
  );
}

/**
 * Thumbnail of the FLATTENED output (crop and redactions applied), at most `maxWidth` wide. History
 * (phase 07) must use this and never a thumbnail of the original capture.
 */
export async function flattenThumbnail(
  baseImage: ImageBitmap,
  doc: EditorDoc,
  maxWidth: number = THUMBNAIL_MAX_WIDTH,
): Promise<Blob> {
  const full = await flattenToCanvas(baseImage, doc);
  const scale = Math.min(1, maxWidth / full.width);
  const thumb = newCanvas(Math.round(full.width * scale), Math.round(full.height * scale));
  const context = thumb.getContext('2d');
  if (!context) throw new Error('Could not create a 2D canvas context.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(full, 0, 0, thumb.width, thumb.height);
  return thumb.convertToBlob({ type: 'image/png' });
}
