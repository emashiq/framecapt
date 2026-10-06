import { describe, expect, it } from 'vitest';
import {
  alignCommand,
  distributeCommand,
  duplicateCommand,
  snapMove,
  zOrderCommand,
} from '../../src/renderer/editor/model/arrange';
import { apply, type Command } from '../../src/renderer/editor/model/commands';
import {
  aspectFromAnchor,
  enforceAspect,
  largestAspectRect,
  unionRects,
} from '../../src/renderer/editor/model/geometry';
import { commit, createHistory, undo, redo } from '../../src/renderer/editor/model/history';
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
  beautifyActive,
  createDoc,
  exportSize,
  type Annotation,
  type EditorDoc,
} from '../../src/renderer/editor/model/types';
import { addRecentColor, normalizeHex, DEFAULT_BEAUTIFY } from '../../src/renderer/editor/presets';

const doc = (): EditorDoc => createDoc(400, 300);

const rectAt = (id: string, x: number, y: number, w = 40, h = 30): Annotation => ({
  type: 'rect',
  id,
  rect: { x, y, width: w, height: h },
  color: '#ff0000',
  width: 3,
});

describe('new elements through the command reducer', () => {
  const samples: Annotation[] = [
    {
      type: 'line',
      id: 'l',
      from: { x: 1, y: 2 },
      to: { x: 30, y: 40 },
      color: '#000',
      width: 4,
      dash: 'dotted',
    },
    {
      type: 'ellipse',
      id: 'e',
      rect: { x: 5, y: 5, width: 50, height: 30 },
      color: '#000',
      width: 2,
      fill: '#f00',
      fillOpacity: 0.4,
    },
    { type: 'highlight', id: 'h', rect: { x: 5, y: 5, width: 50, height: 30 }, color: '#ff0' },
    {
      type: 'pen',
      id: 'p',
      points: [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
      ],
      color: '#00f',
      width: 3,
    },
    {
      type: 'blur',
      id: 'b',
      rect: { x: 5, y: 5, width: 50, height: 30 },
      mode: 'pixelate',
      amount: 12,
    },
    { type: 'step', id: 's', at: { x: 20, y: 20 }, number: 1, color: '#00f', size: 30 },
    {
      type: 'callout',
      id: 'c',
      rect: { x: 5, y: 5, width: 80, height: 30 },
      tail: { x: 20, y: 80 },
      text: 'Hi',
      color: '#111',
      textColor: '#fff',
      fontSize: 16,
      fontWeight: 600,
    },
    { type: 'spotlight', id: 'sp', rect: { x: 5, y: 5, width: 50, height: 30 }, shape: 'ellipse' },
    {
      type: 'magnifier',
      id: 'm',
      rect: { x: 5, y: 5, width: 50, height: 50 },
      zoom: 2,
      color: '#fff',
      width: 3,
    },
    { type: 'stamp', id: 'st', at: { x: 20, y: 20 }, stamp: 'star', size: 30, color: '#fa0' },
    { type: 'ruler', id: 'ru', from: { x: 1, y: 2 }, to: { x: 90, y: 2 }, color: '#f00', width: 3 },
  ];

  it.each(samples.map((a) => [a.type, a] as const))(
    'adds, updates, undoes and redoes a %s',
    (_type, annotation) => {
      let h = createHistory(doc());
      h = commit(h, { type: 'add', annotation });
      expect(h.present.annotations).toHaveLength(1);
      h = commit(h, { type: 'update', id: annotation.id, patch: moveAnnotation(annotation, 7, 9) });
      expect(h.present.annotations[0]).not.toEqual(annotation);
      h = undo(h);
      expect(h.present.annotations[0]).toEqual(h.present.annotations[0]);
      h = undo(h);
      expect(h.present.annotations).toHaveLength(0);
      h = redo(h);
      expect(h.present.annotations).toHaveLength(1);
      expect(annotationBounds(annotation).width).toBeGreaterThan(0);
    },
  );

  it('clamps ranges (opacity, blur amount, zoom, radius, shadow)', () => {
    let d = apply(doc(), { type: 'add', annotation: samples[4] as Annotation });
    d = apply(d, { type: 'update', id: 'b', patch: { amount: 5000 } });
    expect(d.annotations[0]).toMatchObject({ amount: 60 });
    d = apply(d, { type: 'add', annotation: rectAt('r', 0, 0) });
    d = apply(d, {
      type: 'update',
      id: 'r',
      patch: { opacity: 7, radius: -4, shadow: { blur: 9999, offset: 1 } },
    });
    expect(d.annotations[1]).toMatchObject({
      opacity: 1,
      radius: 0,
      shadow: { blur: 200, offset: 1 },
    });
    d = apply(d, { type: 'update', id: 'r', patch: { shadow: null } });
    expect('shadow' in (d.annotations[1] as object)).toBe(false);
    d = apply(d, { type: 'add', annotation: samples[8] as Annotation });
    d = apply(d, { type: 'update', id: 'm', patch: { zoom: 100 } });
    expect(d.annotations[2]).toMatchObject({ zoom: 8 });
  });

  it('refuses a stamp that is not in the built-in set and an empty pen stroke', () => {
    const bad = { ...(samples[9] as object), stamp: 'skull' } as unknown as Annotation;
    expect(apply(doc(), { type: 'add', annotation: bad })).toEqual(doc());
    const empty = { ...(samples[3] as object), points: [] } as unknown as Annotation;
    expect(apply(doc(), { type: 'add', annotation: empty })).toEqual(doc());
  });

  it('a blur only accepts blur fields; a redaction still takes only its rectangle', () => {
    let d = apply(doc(), { type: 'add', annotation: samples[4] as Annotation });
    expect(apply(d, { type: 'update', id: 'b', patch: { color: '#fff', width: 9 } })).toBe(d);
    d = apply(d, { type: 'update', id: 'b', patch: { mode: 'blur' } });
    expect(d.annotations[0]).toMatchObject({ mode: 'blur' });
  });

  it('batch is one undo step and a no-op batch changes nothing', () => {
    const base = apply(apply(doc(), { type: 'add', annotation: rectAt('a', 0, 0) }), {
      type: 'add',
      annotation: rectAt('b', 50, 0),
    });
    let h = createHistory(base);
    const batch: Command = {
      type: 'batch',
      commands: [
        { type: 'update', id: 'a', patch: { color: '#00ff00' } },
        { type: 'remove', id: 'b' },
      ],
    };
    h = commit(h, batch);
    expect(h.past).toHaveLength(1);
    expect(h.present.annotations).toHaveLength(1);
    h = undo(h);
    expect(h.present).toBe(base);
    expect(apply(base, { type: 'batch', commands: [] })).toBe(base);
  });

  it('history stays capped for many commands', () => {
    let h = createHistory(doc());
    for (let i = 0; i < 260; i += 1)
      h = commit(h, { type: 'add', annotation: rectAt(`r${i}`, i, 0) });
    expect(h.past.length).toBeLessThanOrEqual(200);
  });
});

describe('beautify command and export size', () => {
  it('sets, changes and removes the frame; padding grows the export, the crop stays', () => {
    let d = apply(doc(), { type: 'setCrop', crop: { x: 10, y: 10, width: 100, height: 50 } });
    d = apply(d, { type: 'setBeautify', beautify: { ...DEFAULT_BEAUTIFY, padding: 20 } });
    expect(beautifyActive(d)).toBe(true);
    expect(exportSize(d)).toEqual({ width: 140, height: 90 });
    expect(d.crop).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    const same = apply(d, { type: 'setBeautify', beautify: { ...DEFAULT_BEAUTIFY, padding: 20 } });
    expect(same).toBe(d);
    d = apply(d, { type: 'setBeautify', beautify: null });
    expect(exportSize(d)).toEqual({ width: 100, height: 50 });
    expect('beautify' in d).toBe(false);
  });

  it('clamps padding, radius and opacity, and ignores non-finite values', () => {
    const d = apply(doc(), {
      type: 'setBeautify',
      beautify: { ...DEFAULT_BEAUTIFY, padding: 9999, radius: -3, shadowOpacity: 4 },
    });
    expect(d.beautify).toMatchObject({ padding: 400, radius: 0, shadowOpacity: 1 });
    expect(
      apply(doc(), { type: 'setBeautify', beautify: { ...DEFAULT_BEAUTIFY, padding: NaN } }),
    ).toEqual(doc());
  });
});

describe('document migration', () => {
  it('loads a version 1 document (no schema field, old elements only)', () => {
    const old = {
      width: 400,
      height: 300,
      crop: { x: 10, y: 10, width: 100, height: 100 },
      annotations: [
        {
          type: 'arrow',
          id: 'a',
          from: { x: 0, y: 0 },
          to: { x: 50, y: 50 },
          color: '#f00',
          width: 4,
        },
        {
          type: 'rect',
          id: 'r',
          rect: { x: 5, y: 5, width: 20, height: 20 },
          color: '#0f0',
          width: 3,
        },
        {
          type: 'text',
          id: 't',
          at: { x: 9, y: 9 },
          text: 'hi',
          color: '#000',
          fontSize: 20,
          fontWeight: 600,
        },
        { type: 'redact', id: 'x', rect: { x: 1, y: 1, width: 9, height: 9 } },
      ],
    };
    const result = migrateDoc(old, { width: 400, height: 300 });
    expect(result).toMatchObject({ ok: true, dropped: 0 });
    if (!result.ok) return;
    expect(result.doc.annotations.map((a) => a.type)).toEqual(['arrow', 'rect', 'text', 'redact']);
    expect(result.doc.crop).toEqual({ x: 10, y: 10, width: 100, height: 100 });
  });

  it('round-trips every element through serialize and migrate', () => {
    let d = doc();
    d = apply(d, {
      type: 'add',
      annotation: {
        type: 'arrow',
        id: 'a',
        from: { x: 1, y: 1 },
        to: { x: 90, y: 90 },
        color: '#f00',
        width: 4,
        style: 'curved',
        bend: 0.3,
        startHead: 'dot',
        endHead: 'open',
        shadow: { blur: 4, offset: 2 },
      },
    });
    d = apply(d, {
      type: 'add',
      annotation: {
        type: 'text',
        id: 't',
        at: { x: 1, y: 1 },
        text: 'x',
        color: '#000',
        fontSize: 20,
        fontWeight: 700,
        italic: true,
        family: 'serif',
        align: 'center',
        background: '#fff',
        outlineColor: '#000',
        outlineWidth: 2,
      },
    });
    d = apply(d, { type: 'setBeautify', beautify: DEFAULT_BEAUTIFY });
    const stored = JSON.parse(JSON.stringify(serializeDoc(d))) as unknown;
    expect((stored as { schema: number }).schema).toBe(DOC_SCHEMA);
    const result = migrateDoc(stored, { width: 400, height: 300 });
    expect(result).toMatchObject({ ok: true, dropped: 0 });
    if (result.ok) expect(result.doc).toEqual(d);
  });

  it('refuses a newer schema, a size mismatch and non-objects; drops damaged elements', () => {
    expect(
      migrateDoc(
        { schema: 99, width: 400, height: 300, annotations: [] },
        { width: 400, height: 300 },
      ),
    ).toEqual({ ok: false, reason: 'newer_schema' });
    expect(
      migrateDoc(
        { schema: 2, width: 10, height: 10, annotations: [] },
        { width: 400, height: 300 },
      ),
    ).toEqual({ ok: false, reason: 'size_mismatch' });
    expect(migrateDoc('nope', { width: 1, height: 1 })).toEqual({
      ok: false,
      reason: 'not_object',
    });
    expect(migrateDoc([], { width: 1, height: 1 })).toEqual({ ok: false, reason: 'not_object' });
    const damaged = migrateDoc(
      {
        schema: 2,
        width: 400,
        height: 300,
        annotations: [
          {
            type: 'rect',
            id: 'ok',
            rect: { x: 0, y: 0, width: 5, height: 5 },
            color: '#f00',
            width: 2,
          },
          { type: 'rect', id: 'bad', rect: 'nope', color: '#f00', width: 2 },
          { type: 'warp', id: 'unknown' },
          { type: 'stamp', id: 'st', at: { x: 1, y: 1 }, stamp: 'skull', size: 20, color: '#000' },
          {
            type: 'redact',
            id: 'rd',
            rect: { x: 0, y: 0, width: 5, height: 5 },
            color: '#fff',
            opacity: 0.1,
          },
          null,
        ],
      },
      { width: 400, height: 300 },
    );
    expect(damaged).toMatchObject({ ok: true, dropped: 4 });
    if (damaged.ok) {
      expect(damaged.doc.annotations.map((a) => a.id)).toEqual(['ok', 'rd']);
      // A redaction read back is rebuilt from its rectangle only.
      expect(damaged.doc.annotations[1]).toEqual({
        type: 'redact',
        id: 'rd',
        rect: { x: 0, y: 0, width: 5, height: 5 },
      });
    }
  });
});

describe('z-order, duplicate, align, distribute', () => {
  const three = (): EditorDoc => {
    let d = doc();
    for (const [id, x] of [
      ['a', 0],
      ['b', 100],
      ['c', 220],
    ] as const) {
      d = apply(d, { type: 'add', annotation: rectAt(id, x, 10) });
    }
    return d;
  };
  const order = (d: EditorDoc): string[] => d.annotations.map((a) => a.id);

  it('moves to front, back, forward and backward; no-ops return null', () => {
    const d = three();
    const run = (ids: string[], move: Parameters<typeof zOrderCommand>[2]) => {
      const command = zOrderCommand(d, ids, move);
      return command ? order(apply(d, command)) : null;
    };
    expect(run(['a'], 'front')).toEqual(['b', 'c', 'a']);
    expect(run(['c'], 'back')).toEqual(['c', 'a', 'b']);
    expect(run(['a'], 'forward')).toEqual(['b', 'a', 'c']);
    expect(run(['c'], 'backward')).toEqual(['a', 'c', 'b']);
    expect(run(['a', 'b'], 'forward')).toEqual(['c', 'a', 'b']);
    expect(run(['c'], 'front')).toBeNull();
    expect(run(['a'], 'back')).toBeNull();
  });

  it('the order command rejects anything that is not a permutation', () => {
    const d = three();
    expect(apply(d, { type: 'order', ids: ['a', 'b'] })).toBe(d);
    expect(apply(d, { type: 'order', ids: ['a', 'a', 'b'] })).toBe(d);
    expect(apply(d, { type: 'order', ids: ['a', 'b', 'x'] })).toBe(d);
  });

  it('duplicates with an offset and new ids, as one undo step', () => {
    const d = three();
    let n = 0;
    const made = duplicateCommand(d, ['a', 'c'], 12, () => `copy${(n += 1)}`);
    expect(made?.ids).toEqual(['copy1', 'copy2']);
    let h = createHistory(d);
    h = commit(h, (made as NonNullable<typeof made>).command);
    expect(order(h.present)).toEqual(['a', 'b', 'c', 'copy1', 'copy2']);
    expect(h.present.annotations[3]).toMatchObject({ rect: { x: 12, y: 22 } });
    expect(undo(h).present).toBe(d);
  });

  it('aligns to the group, or to the frame for a single annotation', () => {
    const d = three();
    const left = alignCommand(d, ['a', 'b', 'c'], 'left', { x: 0, y: 0, width: 400, height: 300 });
    const lefted = apply(d, left as Command);
    expect(lefted.annotations.map((a) => annotationBounds(a).x)).toEqual([-1.5, -1.5, -1.5]);
    const center = alignCommand(d, ['b'], 'center', { x: 0, y: 0, width: 400, height: 300 });
    const b = apply(d, center as Command).annotations[1] as Annotation & {
      rect: { x: number; width: number };
    };
    expect(b.rect.x + b.rect.width / 2).toBeCloseTo(200, 6);
    expect(alignCommand(d, ['a'], 'left', { x: -1.5, y: 0, width: 10, height: 10 })).toBeNull();
    const bottom = alignCommand(d, ['a', 'b'], 'bottom', { x: 0, y: 0, width: 1, height: 1 });
    expect(bottom).toBeNull(); // same height and top: already aligned
  });

  it('distributes three annotations with equal gaps; fewer than three do nothing', () => {
    const d = three();
    const spaced = apply(d, distributeCommand(d, ['a', 'b', 'c'], 'horizontal') as Command);
    const boxes = spaced.annotations.map((a) => annotationBounds(a));
    const gap1 = (boxes[1]?.x ?? 0) - ((boxes[0]?.x ?? 0) + (boxes[0]?.width ?? 0));
    const gap2 = (boxes[2]?.x ?? 0) - ((boxes[1]?.x ?? 0) + (boxes[1]?.width ?? 0));
    expect(gap1).toBeCloseTo(gap2, 6);
    expect(distributeCommand(d, ['a', 'b'], 'horizontal')).toBeNull();
  });
});

describe('snapping', () => {
  const frame = { x: 0, y: 0, width: 400, height: 300 };

  it('snaps edges and centers to the canvas within the threshold', () => {
    const near = snapMove({ x: 4, y: 100, width: 50, height: 40 }, [], frame, 6);
    expect(near.dx).toBe(-4);
    expect(near.guides).toEqual([expect.objectContaining({ axis: 'x', position: 0 })]);
    const center = snapMove({ x: 176, y: 20, width: 50, height: 40 }, [], frame, 6);
    expect(center.dx).toBe(-1); // center 201 -> 200
    const far = snapMove({ x: 20, y: 100, width: 50, height: 40 }, [], frame, 6);
    expect(far).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('snaps to other shapes on both axes and reports guides spanning both', () => {
    const other = { x: 200, y: 200, width: 60, height: 30 };
    const result = snapMove({ x: 203, y: 196, width: 40, height: 20 }, [other], frame, 6);
    expect(result.dx).toBe(-3);
    expect(result.dy).toBe(-1); // the nearest line wins: bottom 216 -> the other center 215 (not top 196 -> 200)
    expect(result.guides).toHaveLength(2);
    const vertical = result.guides.find((g) => g.axis === 'x');
    expect(vertical).toMatchObject({ position: 200 });
    expect(vertical && vertical.to).toBeGreaterThanOrEqual(230);
  });
});

describe('hit testing and handles of the new elements', () => {
  it('fills are hit inside, outlines only on the stroke', () => {
    let d = apply(doc(), { type: 'add', annotation: rectAt('plain', 100, 100, 60, 60) });
    expect(hitTest(d, { x: 130, y: 130 }, 1)).toBeNull();
    expect(hitTest(d, { x: 100, y: 130 }, 1)?.id).toBe('plain');
    d = apply(d, { type: 'update', id: 'plain', patch: { fill: '#00f' } });
    expect(hitTest(d, { x: 130, y: 130 }, 1)?.id).toBe('plain');
  });

  it('hits an ellipse inside its curve, a pen near its stroke, a step in its disc', () => {
    let d = apply(doc(), {
      type: 'add',
      annotation: {
        type: 'ellipse',
        id: 'e',
        rect: { x: 0, y: 0, width: 100, height: 100 },
        color: '#000',
        width: 2,
        fill: '#f00',
      },
    });
    expect(hitTest(d, { x: 50, y: 50 }, 1)?.id).toBe('e');
    expect(hitTest(d, { x: 3, y: 3 }, 1)).toBeNull();
    d = apply(d, {
      type: 'add',
      annotation: {
        type: 'pen',
        id: 'p',
        points: [
          { x: 200, y: 200 },
          { x: 300, y: 200 },
        ],
        color: '#000',
        width: 4,
      },
    });
    expect(hitTest(d, { x: 250, y: 202 }, 1)?.id).toBe('p');
    expect(hitTest(d, { x: 250, y: 220 }, 1)).toBeNull();
    d = apply(d, {
      type: 'add',
      annotation: {
        type: 'step',
        id: 's',
        at: { x: 50, y: 250 },
        number: 1,
        color: '#00f',
        size: 30,
      },
    });
    expect(hitTest(d, { x: 60, y: 250 }, 1)?.id).toBe('s');
    expect(hitTest(d, { x: 80, y: 250 }, 1)).toBeNull();
  });

  it('a curved arrow has a bend handle that moves the curve; a callout has a tail handle', () => {
    const arrow: Annotation = {
      type: 'arrow',
      id: 'a',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      color: '#f00',
      width: 4,
      style: 'curved',
      bend: 0.2,
    };
    const handles = handlesFor(arrow);
    expect(handles.map((h) => h.id)).toEqual(['from', 'to', 'ctrl']);
    const mid = handles[2]?.point;
    expect(mid?.y).toBeCloseTo(20, 6); // bow = bend * length
    expect(resizeAnnotation(arrow, 'ctrl', { x: 50, y: -30 }, false)).toEqual({ bend: -0.3 });
    const callout: Annotation = {
      type: 'callout',
      id: 'c',
      rect: { x: 0, y: 0, width: 80, height: 30 },
      tail: { x: 20, y: 70 },
      text: 'x',
      color: '#111',
      textColor: '#fff',
      fontSize: 14,
      fontWeight: 600,
    };
    expect(handlesFor(callout).map((h) => h.id)).toContain('tail');
    expect(resizeAnnotation(callout, 'tail', { x: 5, y: 90 }, false)).toEqual({
      tail: { x: 5, y: 90 },
    });
    expect(moveAnnotation(callout, 10, 10)).toMatchObject({ tail: { x: 30, y: 80 } });
  });
});

describe('crop aspect ratios', () => {
  it('builds a rectangle of the ratio from an anchor, the longer side wins', () => {
    const r = aspectFromAnchor({ x: 10, y: 10 }, { x: 170, y: 40 }, 16 / 9);
    expect(r.width / r.height).toBeCloseTo(16 / 9, 6);
    expect(r.width).toBe(160);
    const up = aspectFromAnchor({ x: 100, y: 100 }, { x: 90, y: 20 }, 1);
    expect(up).toEqual({ x: 20, y: 20, width: 80, height: 80 });
  });

  it('the largest centered rectangle of a ratio', () => {
    expect(largestAspectRect({ x: 0, y: 0, width: 400, height: 300 }, 1)).toEqual({
      x: 50,
      y: 0,
      width: 300,
      height: 300,
    });
    const wide = largestAspectRect({ x: 0, y: 0, width: 400, height: 300 }, 16 / 9);
    expect(wide.width).toBe(400);
    expect(wide.height).toBeCloseTo(225, 6);
    expect(wide.y).toBeCloseTo(37.5, 6);
  });

  it('keeps the ratio while a handle drags, inside the bounds', () => {
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    const previous = { x: 100, y: 100, width: 100, height: 100 };
    const east = enforceAspect(
      { x: 100, y: 100, width: 160, height: 100 },
      previous,
      'e',
      1,
      bounds,
    );
    expect(east.width).toBeCloseTo(east.height, 6);
    expect(east.y + east.height / 2).toBeCloseTo(150, 6);
    const corner = enforceAspect(
      { x: 100, y: 100, width: 500, height: 120 },
      previous,
      'se',
      4 / 3,
      bounds,
    );
    expect(corner.width / corner.height).toBeCloseTo(4 / 3, 6);
    expect(corner.x + corner.width).toBeLessThanOrEqual(400.0001);
    expect(corner.y + corner.height).toBeLessThanOrEqual(300.0001);
  });

  it('union of rectangles', () => {
    expect(
      unionRects([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 5, width: 10, height: 30 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 30, height: 35 });
    expect(unionRects([])).toBeNull();
  });
});

describe('colors', () => {
  it('normalizes hex input', () => {
    expect(normalizeHex('#abc')).toBe('#AABBCC');
    expect(normalizeHex('3b82f6')).toBe('#3B82F6');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
  });

  it('keeps a short, duplicate-free list of recent colors', () => {
    let recent: string[] = [];
    for (const c of ['#111111', '#222222', '#111111', '#333333'])
      recent = addRecentColor(recent, c);
    expect(recent).toEqual(['#333333', '#111111', '#222222']);
    for (let i = 0; i < 20; i += 1)
      recent = addRecentColor(recent, `#${String(i).padStart(2, '0')}0000`);
    expect(recent).toHaveLength(8);
    expect(addRecentColor(recent, 'not a color')).toEqual(recent);
  });
});
