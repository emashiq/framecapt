/**
 * Every editor element against REAL pixels (@napi-rs/canvas, the same `renderDoc` the editor and
 * the export run). Two kinds of checks: the element really paints what it claims, and the editor
 * render and the flattened export show the SAME pixels (parity, explicit tolerance below).
 */
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { renderDoc, type DrawContext } from '../../src/renderer/editor/flatten';
import {
  createDoc,
  exportSize,
  type Annotation,
  type EditorDoc,
  type Rect,
} from '../../src/renderer/editor/model/types';
import { apply } from '../../src/renderer/editor/model/commands';

const W = 240;
const H = 180;

/** A flat mid-grey base with a lighter block, so blur and pixelate have an edge to soften. */
function makeBase(): Canvas {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#E0E0E0';
  ctx.fillRect(100, 60, 50, 50);
  ctx.fillStyle = '#303030';
  ctx.fillRect(60, 100, 30, 30);
  return canvas;
}
const base = makeBase();
const createCanvasLike = (width: number, height: number) => createCanvas(width, height);

function toDoc(annotations: Annotation[], extra: Partial<EditorDoc> = {}): EditorDoc {
  let doc: EditorDoc = { ...createDoc(W, H), ...extra };
  for (const annotation of annotations) doc = apply(doc, { type: 'add', annotation });
  return doc;
}

function renderExport(doc: EditorDoc, format: 'png' | 'jpeg' = 'png'): Canvas {
  const { width, height } = exportSize(doc);
  const canvas = createCanvas(width, height);
  renderDoc(canvas.getContext('2d') as unknown as DrawContext, base, doc, {
    forExport: true,
    format,
    createCanvas: createCanvasLike,
    ...(format === 'jpeg' && { background: '#ffffff' }),
  });
  return canvas;
}

function renderEditor(doc: EditorDoc): Canvas {
  const canvas = createCanvas(doc.width, doc.height);
  renderDoc(canvas.getContext('2d') as unknown as DrawContext, base, doc, {
    forExport: false,
    createCanvas: createCanvasLike,
    cache: new Map(),
  });
  return canvas;
}

function pixels(canvas: Canvas, rect?: Rect): Uint8ClampedArray {
  const r = rect ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
  return canvas.getContext('2d').getImageData(r.x, r.y, r.width, r.height).data;
}

function pixelAt(canvas: Canvas, x: number, y: number): [number, number, number, number] {
  const d = pixels(canvas, { x, y, width: 1, height: 1 });
  return [d[0] as number, d[1] as number, d[2] as number, d[3] as number];
}

/** Largest per-channel difference and the share of pixels that differ at all. */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let max = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    let local = 0;
    for (let c = 0; c < 4; c += 1)
      local = Math.max(local, Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)));
    if (local > 0) differing += 1;
    max = Math.max(max, local);
  }
  return { max, share: differing / (a.length / 4) };
}

const FIXTURES: Record<string, Annotation[]> = {
  arrow: [
    {
      type: 'arrow',
      id: 'a',
      from: { x: 20, y: 150 },
      to: { x: 100, y: 30 },
      color: '#EF4444',
      width: 5,
    },
  ],
  'arrow curved double': [
    {
      type: 'arrow',
      id: 'a',
      from: { x: 20, y: 150 },
      to: { x: 200, y: 40 },
      color: '#3B82F6',
      width: 4,
      style: 'curved',
      bend: 0.3,
      startHead: 'dot',
      endHead: 'open',
    },
  ],
  line: [
    {
      type: 'line',
      id: 'l',
      from: { x: 10, y: 10 },
      to: { x: 200, y: 90 },
      color: '#F59E0B',
      width: 6,
      dash: 'dashed',
    },
  ],
  rect: [
    {
      type: 'rect',
      id: 'r',
      rect: { x: 30, y: 30, width: 90, height: 60 },
      color: '#22C55E',
      width: 4,
      fill: '#8B5CF6',
      fillOpacity: 0.5,
      radius: 12,
      shadow: { blur: 8, offset: 4 },
    },
  ],
  ellipse: [
    {
      type: 'ellipse',
      id: 'e',
      rect: { x: 40, y: 40, width: 120, height: 80 },
      color: '#EF4444',
      width: 3,
      fill: '#F59E0B',
      opacity: 0.8,
    },
  ],
  highlight: [
    { type: 'highlight', id: 'h', rect: { x: 90, y: 50, width: 80, height: 40 }, color: '#FACC15' },
  ],
  'pen stroke': [
    {
      type: 'pen',
      id: 'p',
      points: [
        { x: 20, y: 20 },
        { x: 60, y: 70 },
        { x: 110, y: 30 },
        { x: 170, y: 110 },
      ],
      color: '#EF4444',
      width: 4,
    },
  ],
  'pen highlighter': [
    {
      type: 'pen',
      id: 'p',
      points: [
        { x: 20, y: 120 },
        { x: 120, y: 125 },
        { x: 200, y: 120 },
      ],
      color: '#FACC15',
      width: 18,
      highlighter: true,
    },
  ],
  blur: [
    {
      type: 'blur',
      id: 'b',
      rect: { x: 90, y: 50, width: 70, height: 70 },
      mode: 'blur',
      amount: 6,
    },
  ],
  pixelate: [
    {
      type: 'blur',
      id: 'b',
      rect: { x: 93, y: 53, width: 70, height: 70 },
      mode: 'pixelate',
      amount: 10,
    },
  ],
  step: [{ type: 'step', id: 's', at: { x: 50, y: 50 }, number: 7, color: '#3B82F6', size: 36 }],
  callout: [
    {
      type: 'callout',
      id: 'c',
      rect: { x: 30, y: 20, width: 110, height: 44 },
      tail: { x: 60, y: 110 },
      text: 'Look here',
      color: '#111827',
      textColor: '#FFFFFF',
      fontSize: 16,
      fontWeight: 600,
    },
  ],
  'text styled': [
    {
      type: 'text',
      id: 't',
      at: { x: 20, y: 30 },
      text: 'Hello\nWorld',
      color: '#FFFFFF',
      fontSize: 22,
      fontWeight: 700,
      italic: true,
      align: 'center',
      background: '#111827',
      outlineColor: '#EF4444',
      outlineWidth: 1,
      family: 'mono',
    },
  ],
  spotlight: [
    {
      type: 'spotlight',
      id: 'sp',
      rect: { x: 80, y: 50, width: 80, height: 60 },
      shape: 'ellipse',
    },
  ],
  'spotlight two': [
    { type: 'spotlight', id: 'sp1', rect: { x: 30, y: 30, width: 60, height: 40 }, shape: 'rect' },
    {
      type: 'spotlight',
      id: 'sp2',
      rect: { x: 60, y: 50, width: 80, height: 60 },
      shape: 'rect',
      dim: 0.3,
    },
  ],
  magnifier: [
    {
      type: 'magnifier',
      id: 'm',
      rect: { x: 80, y: 50, width: 70, height: 70 },
      zoom: 2.5,
      color: '#FFFFFF',
      width: 3,
      shadow: { blur: 6, offset: 3 },
    },
  ],
  stamps: (['check', 'cross', 'star', 'heart', 'warning', 'question', 'info'] as const).map(
    (stamp, i) => ({
      type: 'stamp',
      id: `st${i}`,
      at: { x: 25 + i * 30, y: 30 },
      stamp,
      size: 28,
      color: '#3B82F6',
    }),
  ),
  ruler: [
    {
      type: 'ruler',
      id: 'ru',
      from: { x: 30, y: 140 },
      to: { x: 190, y: 140 },
      color: '#EF4444',
      width: 3,
    },
  ],
  redact: [{ type: 'redact', id: 'rd', rect: { x: 100, y: 60, width: 40, height: 30 } }],
};

describe('every element paints something', () => {
  for (const [name, annotations] of Object.entries(FIXTURES)) {
    it(name, () => {
      const plain = renderExport(toDoc([]));
      const drawn = renderExport(toDoc(annotations));
      expect(compare(pixels(plain), pixels(drawn)).share).toBeGreaterThan(0.0005);
    });
  }
});

describe('editor render and flattened export agree (parity)', () => {
  // The export of a crop must equal the same region of the editor render. It is the same code, so
  // the only differences are Skia's anti-aliasing of path edges on canvases of different sizes
  // (measured: at most 17 levels on at most 0.5 % of the pixels, for dashes, curves and glyph
  // edges). A missing or misplaced element would differ on far more pixels.
  const TOLERANCE_LEVELS = 24;
  const TOLERANCE_SHARE = 0.006;
  const crop = { x: 10, y: 5, width: 200, height: 150 };
  for (const [name, annotations] of Object.entries(FIXTURES)) {
    it(name, () => {
      const doc = toDoc(annotations, { crop });
      const fromEditor = pixels(renderEditor(doc), crop);
      const fromExport = pixels(renderExport(doc));
      const result = compare(fromEditor, fromExport);
      expect(result.max).toBeLessThanOrEqual(TOLERANCE_LEVELS);
      expect(result.share).toBeLessThanOrEqual(TOLERANCE_SHARE);
    });
  }

  it('all elements together, uncropped', () => {
    const doc = toDoc(
      Object.values(FIXTURES)
        .flat()
        .map((a, i) => ({ ...a, id: `all${i}` }) as Annotation),
    );
    const result = compare(pixels(renderEditor(doc)), pixels(renderExport(doc)));
    expect(result.max).toBeLessThanOrEqual(TOLERANCE_LEVELS);
    expect(result.share).toBeLessThanOrEqual(TOLERANCE_SHARE);
  });
});

describe('element behaviour', () => {
  it('ellipse fills its center and leaves the corners of its box alone', () => {
    const doc = toDoc([
      {
        type: 'ellipse',
        id: 'e',
        rect: { x: 40, y: 40, width: 120, height: 80 },
        color: '#000000',
        width: 0,
        fill: '#FF0000',
      },
    ]);
    const out = renderExport(doc);
    expect(pixelAt(out, 100, 80).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixelAt(out, 42, 42).slice(0, 3)).toEqual(
      pixelAt(renderExport(toDoc([])), 42, 42).slice(0, 3),
    );
  });

  it('a rectangle with width 0 and no fill draws nothing', () => {
    const doc = toDoc([
      {
        type: 'rect',
        id: 'r',
        rect: { x: 10, y: 10, width: 50, height: 50 },
        color: '#FF0000',
        width: 0,
      },
    ]);
    expect(compare(pixels(renderExport(doc)), pixels(renderExport(toDoc([])))).max).toBe(0);
  });

  it('a highlight multiplies: it darkens, never lightens', () => {
    const doc = toDoc([
      { type: 'highlight', id: 'h', rect: { x: 0, y: 0, width: 50, height: 50 }, color: '#FFFF00' },
    ]);
    const [r, g, b] = pixelAt(renderExport(doc), 10, 10);
    // 0x80 grey times yellow at 40 %: blue drops, red and green stay close.
    expect(b).toBeLessThan(0x80);
    expect(r).toBeGreaterThan(0x70);
    expect(g).toBeGreaterThan(0x70);
  });

  it('blur softens an edge and pixelate makes flat blocks', () => {
    const edge = { x: 90, y: 50, width: 70, height: 70 };
    const plain = renderExport(toDoc([]));
    const blurred = renderExport(
      toDoc([{ type: 'blur', id: 'b', rect: edge, mode: 'blur', amount: 8 }]),
    );
    // On the sharp edge of the light block (x = 100) the blurred pixel is between the two levels.
    const before = pixelAt(plain, 99, 80)[0];
    const after = pixelAt(blurred, 99, 80)[0];
    expect(Math.abs(after - before)).toBeGreaterThan(8);
    const pix = renderExport(
      toDoc([{ type: 'blur', id: 'b', rect: edge, mode: 'pixelate', amount: 10 }]),
    );
    expect(pixelAt(pix, 92, 52)).toEqual(pixelAt(pix, 97, 57));
  });

  it('blur results are cached between renders', () => {
    const doc = toDoc([
      {
        type: 'blur',
        id: 'b',
        rect: { x: 90, y: 50, width: 70, height: 70 },
        mode: 'blur',
        amount: 8,
      },
    ]);
    const cache = new Map();
    let canvases = 0;
    const counting = (w: number, h: number) => {
      canvases += 1;
      return createCanvas(w, h);
    };
    const target = createCanvas(W, H);
    for (let i = 0; i < 3; i += 1) {
      renderDoc(target.getContext('2d') as unknown as DrawContext, base, doc, {
        forExport: false,
        createCanvas: counting,
        cache,
      });
    }
    expect(canvases).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('a spotlight dims outside the shape only; two spotlights keep both areas clear', () => {
    const one = renderExport(
      toDoc([
        {
          type: 'spotlight',
          id: 's',
          rect: { x: 80, y: 50, width: 80, height: 60 },
          shape: 'rect',
        },
      ]),
    );
    expect(pixelAt(one, 90, 56)[0]).toBe(0x80);
    expect(pixelAt(one, 5, 5)[0]).toBeLessThan(0x80);
    const two = renderExport(toDoc(FIXTURES['spotlight two'] as Annotation[]));
    expect(pixelAt(two, 40, 35)[0]).toBe(0x80); // inside the first only
    expect(pixelAt(two, 110, 55)[0]).toBe(0x80); // inside the second only
    expect(pixelAt(two, 5, 170)[0]).toBeLessThan(0x80);
  });

  it('a magnifier shows the image enlarged around its own center', () => {
    // The dark 30x30 block at (60,100): a magnifier centered on it at 3x is mostly dark.
    const doc = toDoc([
      {
        type: 'magnifier',
        id: 'm',
        rect: { x: 55, y: 95, width: 40, height: 40 },
        zoom: 3,
        color: '#FFFFFF',
        width: 0,
      },
    ]);
    const out = renderExport(doc);
    expect(pixelAt(out, 75, 115)[0]).toBe(0x30);
    expect(pixelAt(out, 62, 102)[0]).toBe(0x30); // enlarged: reaches the magnifier's edge
  });

  it('a step badge is its color with a readable number', () => {
    const out = renderExport(
      toDoc([
        { type: 'step', id: 's', at: { x: 50, y: 50 }, number: 3, color: '#111111', size: 40 },
      ]),
    );
    expect(pixelAt(out, 33, 50).slice(0, 3)).toEqual([0x11, 0x11, 0x11]);
  });

  it('redactions stay solid black above every element and are never blurred or dimmed', () => {
    const rect = { x: 100, y: 60, width: 40, height: 30 };
    const doc = toDoc([
      { type: 'redact', id: 'rd', rect },
      {
        type: 'highlight',
        id: 'h',
        rect: { x: 90, y: 50, width: 80, height: 60 },
        color: '#FFFF00',
      },
      { type: 'spotlight', id: 'sp', rect: { x: 0, y: 0, width: 20, height: 20 }, shape: 'rect' },
      {
        type: 'blur',
        id: 'b',
        rect: { x: 90, y: 50, width: 80, height: 60 },
        mode: 'blur',
        amount: 5,
      },
      { type: 'stamp', id: 'st', at: { x: 120, y: 75 }, stamp: 'star', size: 40, color: '#FF0000' },
    ]);
    for (const out of [renderExport(doc), renderEditor(doc)]) {
      for (const [x, y] of [
        [100, 60],
        [139, 89],
        [120, 75],
        [101, 61],
      ] as const) {
        expect(pixelAt(out, x, y)).toEqual([0, 0, 0, 255]);
      }
    }
  });
});

describe('beautify frame', () => {
  const beautify = {
    background: { kind: 'solid', color: '#FF0000' } as const,
    padding: 30,
    radius: 20,
    shadowBlur: 0,
    shadowOffset: 0,
    shadowOpacity: 0,
  };

  it('grows the export by the padding on every side and keeps the crop non-destructive', () => {
    const doc = toDoc([], { crop: { x: 10, y: 10, width: 100, height: 80 }, beautify });
    expect(exportSize(doc)).toEqual({ width: 160, height: 140 });
    expect(doc.crop).toEqual({ x: 10, y: 10, width: 100, height: 80 });
    const out = renderExport(doc);
    expect(out.width).toBe(160);
    expect(pixelAt(out, 2, 2).slice(0, 3)).toEqual([255, 0, 0]);
    // The middle of the image is the base's pixel at the cropped position (flat grey).
    expect(pixelAt(out, 80, 70).slice(0, 3)).toEqual([0x80, 0x80, 0x80]);
  });

  it('rounds the corners of the image', () => {
    const doc = toDoc([], { beautify });
    const out = renderExport(doc);
    // The image's top-left corner pixel (30, 30) is outside the rounded corner: background shows.
    expect(pixelAt(out, 31, 31).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixelAt(out, 30 + 60, 30 + 60).slice(0, 3)).not.toEqual([255, 0, 0]);
  });

  it('draws a gradient and a shadow without covering the image', () => {
    const doc = toDoc([], {
      beautify: {
        ...beautify,
        background: { kind: 'gradient', from: '#000000', to: '#FFFFFF', angle: 90 },
        shadowBlur: 20,
        shadowOffset: 10,
        shadowOpacity: 0.6,
        radius: 0,
      },
    });
    const out = renderExport(doc);
    // Left edge is darker than the right edge of the gradient.
    expect(pixelAt(out, 2, 5)[0]).toBeLessThan(pixelAt(out, out.width - 3, 5)[0]);
    // The image itself is untouched (flat grey at its center).
    expect(pixelAt(out, 30 + 40, 30 + 40).slice(0, 3)).toEqual([0x80, 0x80, 0x80]);
  });

  it('redactions inside a framed JPEG export are black on the output block grid', () => {
    const rect = { x: 100, y: 60, width: 40, height: 30 };
    const doc = toDoc([{ type: 'redact', id: 'r', rect }], {
      crop: { x: 10, y: 10, width: 200, height: 150 },
      beautify: { ...beautify, padding: 25 },
    });
    const out = renderExport(doc, 'jpeg');
    const x = rect.x - 10 + 25;
    const y = rect.y - 10 + 25;
    expect(pixelAt(out, x + 1, y + 1).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(out, x + rect.width - 2, y + rect.height - 2).slice(0, 3)).toEqual([0, 0, 0]);
  });
});
