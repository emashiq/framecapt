/**
 * The flattener against REAL pixels: @napi-rs/canvas (Skia) runs the same `renderDoc` that the
 * editor runs in Chromium. The base image is random noise so that any leaked original pixel under
 * a redaction would be detected. The Chromium encoder path is covered separately by the e2e suite.
 */
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  JPEG_BLOCK,
  JPEG_MARGIN,
  jpegRedactionCoverage,
  redactionCoverage,
  renderDoc,
  type DrawContext,
} from '../../src/renderer/editor/flatten';
import { apply, createRedact } from '../../src/renderer/editor/model/commands';
import { commit, createHistory, undo } from '../../src/renderer/editor/model/history';
import { annotationBounds } from '../../src/renderer/editor/model/hit-test';
import {
  createDoc,
  exportRect,
  exportSize,
  type Annotation,
  type EditorDoc,
  type Rect,
} from '../../src/renderer/editor/model/types';

const WIDTH = 220;
const HEIGHT = 160;

/** Deterministic noise (mulberry32) so failures reproduce. */
function noiseCanvas(width: number, height: number, seed = 12345): Canvas {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    // Never near black, so a leak under a redaction cannot hide as "already dark".
    image.data[i] = 80 + Math.floor(next() * 176);
    image.data[i + 1] = 80 + Math.floor(next() * 176);
    image.data[i + 2] = 80 + Math.floor(next() * 176);
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

const base = noiseCanvas(WIDTH, HEIGHT);
const basePixels = base.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT);

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function render(doc: EditorDoc, format: 'png' | 'jpeg' = 'png'): Canvas {
  const { width, height } = exportSize(doc);
  const canvas = createCanvas(width, height);
  renderDoc(canvas.getContext('2d') as unknown as DrawContext, base, doc, {
    forExport: true,
    format,
    ...(format === 'jpeg' && { background: '#ffffff' }),
  });
  return canvas;
}

async function roundTrip(canvas: Canvas, format: 'png' | 'jpeg'): Promise<Pixels> {
  const bytes = format === 'png' ? await canvas.encode('png') : await canvas.encode('jpeg', 92);
  const image = await loadImage(bytes);
  const out = createCanvas(image.width, image.height);
  const context = out.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height);
  return { width: data.width, height: data.height, data: data.data };
}

const px = (pixels: Pixels, x: number, y: number): number[] => {
  const i = (y * pixels.width + x) * 4;
  return [pixels.data[i] ?? 0, pixels.data[i + 1] ?? 0, pixels.data[i + 2] ?? 0];
};

/** Integer pixels the user-drawn redaction rect touches, translated by the crop and clipped. */
function userCover(rect: Rect, doc: EditorDoc, out: Pixels): Rect | null {
  const crop = exportRect(doc);
  const x0 = Math.max(0, Math.floor(rect.x) - crop.x);
  const y0 = Math.max(0, Math.floor(rect.y) - crop.y);
  const x1 = Math.min(out.width, Math.ceil(rect.x + rect.width) - crop.x);
  const y1 = Math.min(out.height, Math.ceil(rect.y + rect.height) - crop.y);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function forEachPixel(rect: Rect, visit: (x: number, y: number) => void): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) visit(x, y);
  }
}

const REDACTIONS: Rect[] = [
  { x: 10.4, y: 20.6, width: 40.3, height: 30.2 },
  { x: 100.5, y: 60.5, width: 50, height: 40.9 },
  { x: 200.2, y: 10, width: 30, height: 20 }, // sticks out of the right edge of the image
];

function buildDoc(options: { crop?: Rect } = {}): EditorDoc {
  let doc = createDoc(WIDTH, HEIGHT);
  const add = (annotation: Annotation): void => {
    doc = apply(doc, { type: 'add', annotation });
  };
  // Annotations that overlap the redactions and are drawn BEFORE and AFTER them in z-order.
  add({
    type: 'arrow',
    id: 'arrow-over',
    from: { x: 0, y: 30 },
    to: { x: 120, y: 80 },
    color: '#EF4444',
    width: 6,
  });
  REDACTIONS.forEach((rect, index) => add(createRedact(`r${index}`, rect)));
  add({
    type: 'text',
    id: 'text-after',
    at: { x: 12, y: 24 },
    text: 'SECRET 1234\nsecond line',
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: 600,
  });
  add({
    type: 'rect',
    id: 'rect-after',
    rect: { x: 95, y: 55, width: 70, height: 60 },
    color: '#3B82F6',
    width: 5,
  });
  add({
    type: 'arrow',
    id: 'arrow-after',
    from: { x: 160, y: 120 },
    to: { x: 60, y: 40 },
    color: '#22C55E',
    width: 4,
  });
  if (options.crop) doc = apply(doc, { type: 'setCrop', crop: options.crop });
  return doc;
}

describe('redactionCoverage', () => {
  it('snaps outward to whole pixels and adds one more on every side', () => {
    expect(redactionCoverage({ x: 10.4, y: 20.6, width: 40.3, height: 30.2 })).toEqual({
      x: 9,
      y: 19,
      width: 43, // x: 9 .. ceil(50.7) + 1 = 52
      height: 33, // y: 19 .. ceil(50.8) + 1 = 52
    });
    expect(redactionCoverage({ x: 5, y: 5, width: 10, height: 10 })).toEqual({
      x: 4,
      y: 4,
      width: 12,
      height: 12,
    });
  });
});

describe.each([
  { name: 'whole image', crop: undefined },
  { name: 'crop that cuts through a redaction', crop: { x: 30, y: 35, width: 150, height: 100 } },
])('flatten ($name)', ({ crop }) => {
  const doc = buildDoc(crop ? { crop } : {});

  it('exports exactly the crop size', async () => {
    const out = await roundTrip(render(doc), 'png');
    const expected = crop
      ? { width: crop.width, height: crop.height }
      : { width: WIDTH, height: HEIGHT };
    expect({ width: out.width, height: out.height }).toEqual(expected);
  });

  it('PNG: every pixel under every redaction is exactly #000000', async () => {
    const out = await roundTrip(render(doc), 'png');
    let checked = 0;
    for (const rect of REDACTIONS) {
      const cover = userCover(rect, doc, out);
      if (!cover) continue;
      forEachPixel(cover, (x, y) => {
        expect(px(out, x, y)).toEqual([0, 0, 0]);
        checked += 1;
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('PNG: the 1 px expansion is solid as well, so no blended original pixel survives', async () => {
    const out = await roundTrip(render(doc), 'png');
    const crop0 = exportRect(doc);
    for (const rect of REDACTIONS) {
      const cover = redactionCoverage(rect);
      const x0 = Math.max(0, cover.x - crop0.x);
      const y0 = Math.max(0, cover.y - crop0.y);
      const x1 = Math.min(out.width, cover.x + cover.width - crop0.x);
      const y1 = Math.min(out.height, cover.y + cover.height - crop0.y);
      if (x1 <= x0 || y1 <= y0) continue;
      forEachPixel({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, (x, y) => {
        expect(px(out, x, y)).toEqual([0, 0, 0]);
      });
    }
  });

  it('JPEG: every pixel under every redaction stays solid (max channel <= 8)', async () => {
    const out = await roundTrip(render(doc, 'jpeg'), 'jpeg');
    expect({ width: out.width, height: out.height }).toEqual(exportSize(doc));
    let worst = 0;
    for (const rect of REDACTIONS) {
      const cover = userCover(rect, doc, out);
      if (!cover) continue;
      forEachPixel(cover, (x, y) => {
        worst = Math.max(worst, ...px(out, x, y));
      });
    }
    expect(worst).toBeLessThanOrEqual(8);
  });
});

describe('pixels without annotations', () => {
  it('PNG: everything an annotation cannot reach equals the base image exactly', async () => {
    // A sparse document, so there is plenty of untouched area to compare.
    let doc = createDoc(WIDTH, HEIGHT);
    doc = apply(doc, {
      type: 'add',
      annotation: createRedact('r', { x: 20.5, y: 20.5, width: 30, height: 20 }),
    });
    doc = apply(doc, {
      type: 'add',
      annotation: {
        type: 'arrow',
        id: 'a',
        from: { x: 60, y: 30 },
        to: { x: 120, y: 60 },
        color: '#EF4444',
        width: 6,
      },
    });
    doc = apply(doc, { type: 'setCrop', crop: { x: 10, y: 10, width: 200, height: 140 } });
    const out = await roundTrip(render(doc), 'png');
    const origin = exportRect(doc);
    const touched: Rect[] = doc.annotations.map((annotation) => {
      if (annotation.type === 'redact') return redactionCoverage(annotation.rect);
      const bounds = annotationBounds(annotation);
      return {
        x: bounds.x - 4,
        y: bounds.y - 4,
        width: bounds.width + 8,
        height: bounds.height + 8,
      };
    });
    let compared = 0;
    forEachPixel({ x: 0, y: 0, width: out.width, height: out.height }, (x, y) => {
      const ix = x + origin.x;
      const iy = y + origin.y;
      if (touched.some((t) => ix >= t.x && ix < t.x + t.width && iy >= t.y && iy < t.y + t.height))
        return;
      const i = (iy * WIDTH + ix) * 4;
      expect(px(out, x, y)).toEqual([
        basePixels.data[i],
        basePixels.data[i + 1],
        basePixels.data[i + 2],
      ]);
      compared += 1;
    });
    expect(compared).toBeGreaterThan(20000);
  });
});

describe('JPEG redaction coverage', () => {
  it('is needed: a plain 1 px expansion encoded as JPEG leaves visibly non-black pixels on noise', async () => {
    let doc = createDoc(WIDTH, HEIGHT);
    doc = apply(doc, {
      type: 'add',
      annotation: createRedact('r', { x: 41, y: 43, width: 60, height: 50 }),
    });
    const out = await roundTrip(render(doc, 'png'), 'jpeg'); // PNG-style coverage, JPEG-encoded
    let worst = 0;
    forEachPixel({ x: 41, y: 43, width: 60, height: 50 }, (x, y) => {
      worst = Math.max(worst, ...px(out, x, y));
    });
    expect(worst).toBeGreaterThan(8);
    const safe = await roundTrip(render(doc, 'jpeg'), 'jpeg');
    worst = 0;
    forEachPixel({ x: 41, y: 43, width: 60, height: 50 }, (x, y) => {
      worst = Math.max(worst, ...px(safe, x, y));
    });
    expect(worst).toBeLessThanOrEqual(8);
  });

  it('grows to the 16 px grid of the output plus a margin, never by more than block + margin', () => {
    const rect = { x: 41.2, y: 43.7, width: 60.1, height: 50.2 };
    for (const origin of [
      { x: 0, y: 0 },
      { x: 30, y: 35 },
      { x: 7, y: 3 },
    ]) {
      const cover = jpegRedactionCoverage(rect, origin);
      expect((cover.x - origin.x) % JPEG_BLOCK).toBe(0);
      expect((cover.y - origin.y) % JPEG_BLOCK).toBe(0);
      expect((cover.x + cover.width - origin.x) % JPEG_BLOCK).toBe(0);
      expect(rect.x - cover.x).toBeGreaterThanOrEqual(JPEG_MARGIN);
      expect(cover.x + cover.width - (rect.x + rect.width)).toBeGreaterThanOrEqual(JPEG_MARGIN);
      expect(rect.x - cover.x).toBeLessThanOrEqual(JPEG_BLOCK + JPEG_MARGIN);
      expect(cover.y + cover.height - (rect.y + rect.height)).toBeLessThanOrEqual(
        JPEG_BLOCK + JPEG_MARGIN,
      );
    }
  });
});

describe('model drives the export', () => {
  it('undoing a redaction brings the original pixels back; redo covers them again', async () => {
    const target: Rect = { x: 40, y: 40, width: 30, height: 20 };
    let history = createHistory(createDoc(WIDTH, HEIGHT));
    history = commit(history, { type: 'add', annotation: createRedact('r', target) });

    const covered = await roundTrip(render(history.present), 'png');
    expect(px(covered, 50, 50)).toEqual([0, 0, 0]);

    history = undo(history);
    const restored = await roundTrip(render(history.present), 'png');
    forEachPixel(target, (x, y) => {
      const i = (y * WIDTH + x) * 4;
      expect(px(restored, x, y)).toEqual([
        basePixels.data[i],
        basePixels.data[i + 1],
        basePixels.data[i + 2],
      ]);
    });
  });

  it('a redaction is above text and arrows added later; z-order never uncovers it', async () => {
    let doc = createDoc(WIDTH, HEIGHT);
    doc = apply(doc, {
      type: 'add',
      annotation: createRedact('r', { x: 20, y: 20, width: 100, height: 60 }),
    });
    doc = apply(doc, {
      type: 'add',
      annotation: {
        type: 'text',
        id: 't',
        at: { x: 25, y: 25 },
        text: 'WHITE TEXT OVER IT',
        color: '#FFFFFF',
        fontSize: 30,
        fontWeight: 700,
      },
    });
    doc = apply(doc, {
      type: 'add',
      annotation: {
        type: 'arrow',
        id: 'a',
        from: { x: 0, y: 0 },
        to: { x: 200, y: 150 },
        color: '#FFFFFF',
        width: 12,
      },
    });
    const out = await roundTrip(render(doc), 'png');
    forEachPixel({ x: 20, y: 20, width: 100, height: 60 }, (x, y) => {
      expect(px(out, x, y)).toEqual([0, 0, 0]);
    });
  });

  it('an unedited document exports the base pixels unchanged', async () => {
    const out = await roundTrip(render(createDoc(WIDTH, HEIGHT)), 'png');
    for (let y = 0; y < HEIGHT; y += 7) {
      for (let x = 0; x < WIDTH; x += 5) {
        const i = (y * WIDTH + x) * 4;
        expect(px(out, x, y)).toEqual([
          basePixels.data[i],
          basePixels.data[i + 1],
          basePixels.data[i + 2],
        ]);
      }
    }
  });

  it('a redaction outside the crop is clipped and never shifts the crop result', async () => {
    let doc = createDoc(WIDTH, HEIGHT);
    doc = apply(doc, {
      type: 'add',
      annotation: createRedact('r', { x: 150, y: 100, width: 40, height: 40 }),
    });
    doc = apply(doc, { type: 'setCrop', crop: { x: 0, y: 0, width: 100, height: 80 } });
    const out = await roundTrip(render(doc), 'png');
    expect({ width: out.width, height: out.height }).toEqual({ width: 100, height: 80 });
    for (let y = 0; y < 80; y += 3) {
      for (let x = 0; x < 100; x += 3) {
        const i = (y * WIDTH + x) * 4;
        expect(px(out, x, y)).toEqual([
          basePixels.data[i],
          basePixels.data[i + 1],
          basePixels.data[i + 2],
        ]);
      }
    }
  });
});
