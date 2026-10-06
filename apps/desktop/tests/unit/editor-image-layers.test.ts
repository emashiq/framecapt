/**
 * Image layers (document schema 3): the model (commands, hit testing, resizing, migration), the
 * asset bookkeeping, and the flattener against real pixels (@napi-rs/canvas runs the same
 * `renderDoc` the editor runs in Chromium).
 */
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  MAX_ASSETS,
  MAX_ASSETS_BYTES,
  assetLimit,
  assetsToSave,
  usedAssetIds,
  type EditorAsset,
} from '../../src/renderer/editor/assets';
import { renderDoc, type DrawAsset, type DrawContext } from '../../src/renderer/editor/flatten';
import { duplicateCommand, zOrderCommand } from '../../src/renderer/editor/model/arrange';
import { apply, type Command } from '../../src/renderer/editor/model/commands';
import { imageAt } from '../../src/renderer/editor/model/create';
import { commit, createHistory, redo, undo } from '../../src/renderer/editor/model/history';
import {
  annotationBounds,
  handlesFor,
  hitTest,
  moveAnnotation,
  resizeAnnotation,
} from '../../src/renderer/editor/model/hit-test';
import { migrateDoc, serializeDoc } from '../../src/renderer/editor/model/migrate';
import {
  DOC_SCHEMA,
  createDoc,
  exportSize,
  type Annotation,
  type EditorDoc,
  type ImageAnnotation,
} from '../../src/renderer/editor/model/types';
import { propsOf, supportFor } from '../../src/renderer/editor/properties';
import { initialStyle } from '../../src/renderer/editor/presets';

const ASSET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const layer = (overrides: Partial<ImageAnnotation> = {}): ImageAnnotation => ({
  type: 'image',
  id: 'img',
  assetId: ASSET,
  rect: { x: 50, y: 40, width: 80, height: 40 },
  ...overrides,
});
const withLayer = (annotation: Annotation = layer()): EditorDoc =>
  apply(createDoc(400, 300), { type: 'add', annotation });

describe('the image element in the document', () => {
  it('is schema 3, and a schema 2 document loads unchanged', () => {
    expect(DOC_SCHEMA).toBe(3);
    const old = {
      schema: 2,
      width: 400,
      height: 300,
      crop: null,
      annotations: [
        {
          type: 'rect',
          id: 'r',
          rect: { x: 1, y: 2, width: 30, height: 20 },
          color: '#f00',
          width: 2,
        },
      ],
    };
    const result = migrateDoc(old, { width: 400, height: 300 });
    expect(result.ok && result.dropped).toBe(0);
    expect(result.ok && result.doc.annotations.map((a) => a.type)).toEqual(['rect']);
  });

  it('survives serialize and migrate, and keeps radius, opacity and shadow', () => {
    const doc = withLayer(layer({ radius: 12, opacity: 0.5, shadow: { blur: 8, offset: 4 } }));
    const stored = serializeDoc(doc);
    expect(stored.schema).toBe(3);
    const back = migrateDoc(JSON.parse(JSON.stringify(stored)), { width: 400, height: 300 });
    expect(back.ok && back.dropped).toBe(0);
    expect(back.ok && back.doc.annotations).toEqual(doc.annotations);
  });

  it('a layer with a bad asset id or extra junk is dropped, never half-loaded', () => {
    const raw = (annotation: unknown) => ({
      schema: 3,
      width: 400,
      height: 300,
      crop: null,
      annotations: [annotation],
    });
    for (const bad of [
      { ...layer(), assetId: '../../evil' },
      { ...layer(), assetId: ASSET.toUpperCase() },
      { ...layer(), rect: { x: 0, y: 0, width: 0, height: 10 } },
      { ...layer(), rect: { x: 0, y: 0, width: Number.NaN, height: 10 } },
    ]) {
      const result = migrateDoc(raw(bad), { width: 400, height: 300 });
      expect(result.ok && result.doc.annotations).toEqual([]);
      expect(result.ok && result.dropped).toBe(1);
    }
  });
});

describe('commands on an image layer', () => {
  it('add rejects an empty or oversized rectangle and a bad asset id', () => {
    const empty = createDoc(400, 300);
    expect(
      apply(empty, {
        type: 'add',
        annotation: layer({ rect: { x: 0, y: 0, width: 0, height: 5 } }),
      }),
    ).toBe(empty);
    expect(
      apply(empty, {
        type: 'add',
        annotation: layer({ rect: { x: 0, y: 0, width: 99999, height: 5 } }),
      }),
    ).toBe(empty);
    expect(apply(empty, { type: 'add', annotation: layer({ assetId: 'nope' }) })).toBe(empty);
  });

  it('update changes only rect, radius, opacity and shadow, and clamps them', () => {
    const doc = withLayer();
    const next = apply(doc, {
      type: 'update',
      id: 'img',
      patch: {
        rect: { x: 10, y: 10, width: 20, height: 20 },
        radius: 9999,
        opacity: 7,
        shadow: { blur: 8, offset: 4 },
        color: '#ff0000',
        text: 'x',
      },
    });
    const updated = next.annotations[0] as ImageAnnotation;
    expect(updated.rect).toEqual({ x: 10, y: 10, width: 20, height: 20 });
    expect(updated.radius).toBe(500);
    expect(updated.opacity).toBe(1);
    expect(updated.shadow).toEqual({ blur: 8, offset: 4 });
    expect(updated.assetId).toBe(ASSET);
    expect('color' in updated).toBe(false);
    expect('text' in updated).toBe(false);
    const cleared = apply(next, { type: 'update', id: 'img', patch: { shadow: null } });
    expect('shadow' in (cleared.annotations[0] as object)).toBe(false);
  });

  it('a flipped rectangle is normalized and a collapsed one is refused', () => {
    const doc = withLayer();
    const flipped = apply(doc, {
      type: 'update',
      id: 'img',
      patch: { rect: { x: 100, y: 100, width: -30, height: -20 } },
    });
    expect((flipped.annotations[0] as ImageAnnotation).rect).toEqual({
      x: 70,
      y: 80,
      width: 30,
      height: 20,
    });
    expect(
      apply(doc, {
        type: 'update',
        id: 'img',
        patch: { rect: { x: 1, y: 1, width: 0, height: 5 } },
      }),
    ).toBe(doc);
  });

  it('insert, move, resize and delete each undo and redo', () => {
    let history = createHistory(createDoc(400, 300));
    const step = (command: Command): void => {
      history = commit(history, command);
    };
    step({ type: 'add', annotation: layer() });
    step({ type: 'update', id: 'img', patch: moveAnnotation(layer(), 10, 5) });
    step({ type: 'update', id: 'img', patch: { rect: { x: 60, y: 45, width: 160, height: 80 } } });
    step({ type: 'remove', id: 'img' });
    expect(history.present.annotations).toEqual([]);
    history = undo(history); // delete
    expect((history.present.annotations[0] as ImageAnnotation).rect.width).toBe(160);
    history = undo(history); // resize
    expect((history.present.annotations[0] as ImageAnnotation).rect).toMatchObject({
      x: 60,
      y: 45,
      width: 80,
    });
    history = undo(history); // move
    expect((history.present.annotations[0] as ImageAnnotation).rect.x).toBe(50);
    history = undo(history); // insert
    expect(history.present.annotations).toEqual([]);
    history = redo(history);
    expect(history.present.annotations).toHaveLength(1);
  });

  it('duplicate reuses the same picture', () => {
    const doc = withLayer();
    let n = 0;
    const made = duplicateCommand(doc, ['img'], 12, () => `copy${(n += 1)}`);
    const next = apply(doc, made!.command);
    const copy = next.annotations[1] as ImageAnnotation;
    expect(copy).toMatchObject({ type: 'image', id: 'copy1', assetId: ASSET });
    expect(copy.rect).toMatchObject({ x: 62, y: 52 });
    expect(usedAssetIds(next)).toEqual(new Set([ASSET]));
  });

  it('z-order moves an image above and below other marks', () => {
    let doc = withLayer();
    doc = apply(doc, {
      type: 'add',
      annotation: {
        type: 'rect',
        id: 'r',
        rect: { x: 0, y: 0, width: 5, height: 5 },
        color: '#000',
        width: 1,
      },
    });
    const command = zOrderCommand(doc, ['img'], 'front');
    expect(apply(doc, command!).annotations.map((a) => a.id)).toEqual(['r', 'img']);
  });
});

describe('hit testing and resizing an image layer', () => {
  const doc = withLayer();

  it('the whole rectangle is the target, and the topmost layer wins', () => {
    expect(hitTest(doc, { x: 60, y: 50 }, 2)?.id).toBe('img');
    expect(hitTest(doc, { x: 10, y: 10 }, 2)).toBeNull();
    const two = apply(doc, {
      type: 'add',
      annotation: layer({ id: 'top', rect: { x: 55, y: 45, width: 20, height: 20 } }),
    });
    expect(hitTest(two, { x: 60, y: 50 }, 2)?.id).toBe('top');
  });

  it('bounds and handles are the rectangle and its eight handles', () => {
    expect(annotationBounds(layer())).toEqual(layer().rect);
    expect(
      handlesFor(layer())
        .map((h) => h.id)
        .sort(),
    ).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
  });

  it('a corner drag keeps the proportions; Shift frees them', () => {
    const kept = resizeAnnotation(layer(), 'se', { x: 210, y: 90 }, false);
    expect(kept.rect).toBeDefined();
    const rect = kept.rect!;
    expect(rect.x).toBe(50);
    expect(rect.y).toBe(40);
    expect(rect.width / rect.height).toBeCloseTo(2, 6);
    const free = resizeAnnotation(layer(), 'se', { x: 210, y: 90 }, true);
    expect(free.rect).toEqual({ x: 50, y: 40, width: 160, height: 50 });
  });

  it('an edge drag keeps the proportions too (the other axis stays centered)', () => {
    const rect = resizeAnnotation(layer(), 'e', { x: 210, y: 60 }, false).rect!;
    expect(rect.width).toBeCloseTo(160, 6);
    expect(rect.height).toBeCloseTo(80, 6);
    expect(rect.y + rect.height / 2).toBeCloseTo(60, 6); // centered on the old middle (40 + 20)
    const free = resizeAnnotation(layer(), 'e', { x: 210, y: 60 }, true).rect!;
    expect(free).toEqual({ x: 50, y: 40, width: 160, height: 40 });
  });

  it('dragging a corner past the opposite one flips instead of collapsing', () => {
    const rect = resizeAnnotation(layer(), 'se', { x: 10, y: 10 }, false).rect!;
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.width / rect.height).toBeCloseTo(2, 6);
  });
});

describe('placing a new image layer', () => {
  const canvas = { width: 1000, height: 800 };

  it('fits within 60 % of the canvas, never scales up, and is centered', () => {
    const big = imageAt('id', ASSET, { width: 3000, height: 1000 }, canvas) as ImageAnnotation;
    expect(big.rect.width).toBe(600);
    expect(big.rect.height).toBe(200);
    expect(big.rect.x + big.rect.width / 2).toBe(500);
    expect(big.rect.y + big.rect.height / 2).toBe(400);
    const tall = imageAt('id', ASSET, { width: 500, height: 4000 }, canvas) as ImageAnnotation;
    expect(tall.rect.height).toBe(480);
    const small = imageAt('id', ASSET, { width: 100, height: 50 }, canvas) as ImageAnnotation;
    expect(small.rect).toMatchObject({ width: 100, height: 50 });
  });

  it('a drop point centers the picture there, kept inside the canvas', () => {
    const at = imageAt('id', ASSET, { width: 100, height: 50 }, canvas, {
      x: 300,
      y: 200,
    }) as ImageAnnotation;
    expect(at.rect).toEqual({ x: 250, y: 175, width: 100, height: 50 });
    const corner = imageAt('id', ASSET, { width: 100, height: 50 }, canvas, {
      x: 5,
      y: 5,
    }) as ImageAnnotation;
    expect(corner.rect).toMatchObject({ x: 0, y: 0 });
    const far = imageAt('id', ASSET, { width: 100, height: 50 }, canvas, {
      x: 5000,
      y: 5000,
    }) as ImageAnnotation;
    expect(far.rect).toMatchObject({ x: 900, y: 750 });
  });

  it('the properties panel offers radius, opacity, shadow and Reset size for it', () => {
    const support = supportFor('image');
    expect(support).toMatchObject({
      radius: true,
      opacity: true,
      shadow: true,
      image: true,
      color: false,
    });
    const values = propsOf(
      layer({ radius: 6, opacity: 0.4 }),
      initialStyle({ width: 400, height: 300 }),
    );
    expect(values.radius).toBe(6);
    expect(values.opacity).toBe(0.4);
  });
});

describe('asset bookkeeping', () => {
  const asset = (id: string, bytes: number): EditorAsset =>
    ({
      id,
      png: new ArrayBuffer(bytes),
      width: 1,
      height: 1,
      image: { close: () => undefined },
    }) as EditorAsset;

  it('only the pictures a document still uses are saved', () => {
    const assets = new Map([
      [ASSET, asset(ASSET, 10)],
      [OTHER, asset(OTHER, 20)],
    ]);
    const doc = withLayer();
    expect(assetsToSave(doc, assets).map((a) => a.id)).toEqual([ASSET]);
    expect(assetsToSave(createDoc(400, 300), assets)).toEqual([]);
  });

  it('caps the number of pictures and their total size, and lets a known picture through', () => {
    const full = new Map(
      Array.from({ length: MAX_ASSETS }, (_, i) => [
        String(i).padStart(64, '0'),
        asset(String(i).padStart(64, '0'), 1),
      ]),
    );
    expect(assetLimit(full, OTHER, 1)).toMatch(/up to 32/);
    expect(assetLimit(full, String(0).padStart(64, '0'), 1)).toBeNull(); // already there
    const heavy = new Map([[ASSET, asset(ASSET, MAX_ASSETS_BYTES - 10)]]);
    expect(assetLimit(heavy, OTHER, 100)).toMatch(/64 MB/);
    expect(assetLimit(heavy, OTHER, 5)).toBeNull();
    expect(assetLimit(new Map(), OTHER, 33 * 1024 * 1024)).toMatch(/too large/);
  });
});

// --- real pixels ---------------------------------------------------------------------------------

const W = 220;
const H = 160;

function solid(width: number, height: number, color: string): Canvas {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas;
}

const base = solid(W, H, '#3366cc');

function render(doc: EditorDoc, assets: Map<string, DrawAsset>): Uint8ClampedArray {
  const { width, height } = exportSize(doc);
  const canvas = createCanvas(width, height);
  renderDoc(canvas.getContext('2d') as unknown as DrawContext, base, doc, {
    forExport: true,
    assets,
  });
  return canvas.getContext('2d').getImageData(0, 0, width, height).data;
}

const pixel = (data: Uint8ClampedArray, x: number, y: number): number[] => {
  const i = (y * W + x) * 4;
  return [data[i] as number, data[i + 1] as number, data[i + 2] as number, data[i + 3] as number];
};

describe('flattening an image layer', () => {
  const red = solid(20, 10, '#ff0000');
  const assets = new Map<string, DrawAsset>([[ASSET, { image: red, width: 20, height: 10 }]]);
  const doc = (extra: Annotation[] = []): EditorDoc => {
    let next = createDoc(W, H);
    for (const annotation of [layer({ rect: { x: 50, y: 40, width: 80, height: 40 } }), ...extra]) {
      next = apply(next, { type: 'add', annotation });
    }
    return next;
  };

  it("the picture's pixels land inside its rectangle, scaled, and nowhere else", () => {
    const data = render(doc(), assets);
    expect(pixel(data, 60, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(data, 129, 79)).toEqual([255, 0, 0, 255]);
    expect(pixel(data, 49, 50)).toEqual([0x33, 0x66, 0xcc, 255]);
    expect(pixel(data, 131, 50)).toEqual([0x33, 0x66, 0xcc, 255]);
    expect(pixel(data, 60, 81)).toEqual([0x33, 0x66, 0xcc, 255]);
  });

  it('opacity blends the picture with what is below', () => {
    const half = createDoc(W, H);
    const data = render(apply(half, { type: 'add', annotation: layer({ opacity: 0.5 }) }), assets);
    const [r, g, b] = pixel(data, 60, 50);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(160); // 0.5 * 255 + 0.5 * 0x33
    expect(g).toBeGreaterThan(40);
    expect(b).toBeGreaterThan(90);
  });

  it('rounded corners cut the picture; the middle stays', () => {
    const data = render(
      apply(createDoc(W, H), { type: 'add', annotation: layer({ radius: 20 }) }),
      assets,
    );
    expect(pixel(data, 50, 40)).toEqual([0x33, 0x66, 0xcc, 255]); // the very corner is outside
    expect(pixel(data, 90, 60)).toEqual([255, 0, 0, 255]);
  });

  it('a drop shadow is drawn under the picture and the shadow caster never shows', () => {
    const data = render(
      apply(createDoc(W, H), {
        type: 'add',
        annotation: layer({ shadow: { blur: 2, offset: 10 } }),
      }),
      assets,
    );
    // Just below the picture the shadow darkens the base; the far-left caster is not visible.
    const below = pixel(data, 90, 86);
    expect(below[2] as number).toBeLessThan(0xcc);
    expect(pixel(data, 5, 5)).toEqual([0x33, 0x66, 0xcc, 255]);
  });

  it('a missing picture draws a neutral placeholder instead of nothing or an error', () => {
    const data = render(doc(), new Map());
    const [r, g, b] = pixel(data, 60, 45);
    expect([r, g, b]).not.toEqual([0x33, 0x66, 0xcc]);
    expect([r, g, b]).not.toEqual([255, 0, 0]);
    expect(Math.abs((r as number) - (g as number))).toBeLessThan(40); // grey-ish
  });

  it('redactions are drawn last: above the image layer, black at full alpha', () => {
    const data = render(
      doc([{ type: 'redact', id: 'cover', rect: { x: 70, y: 50, width: 30, height: 20 } }]),
      assets,
    );
    expect(pixel(data, 80, 60)).toEqual([0, 0, 0, 255]);
    expect(pixel(data, 100, 60)).toEqual([0, 0, 0, 255]);
    expect(pixel(data, 60, 60)).toEqual([255, 0, 0, 255]); // outside the cover: still the picture
  });

  it('a layer hanging over the edge is clipped by the export, and a crop keeps its part', () => {
    const edge = apply(createDoc(W, H), {
      type: 'add',
      annotation: layer({ rect: { x: 200, y: 140, width: 80, height: 40 } }),
    });
    const data = render(edge, assets);
    expect(pixel(data, 219, 159)).toEqual([255, 0, 0, 255]);
    const cropped = apply(edge, {
      type: 'setCrop',
      crop: { x: 190, y: 130, width: 30, height: 30 },
    });
    expect(exportSize(cropped)).toEqual({ width: 30, height: 30 });
  });
});
