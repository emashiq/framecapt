import { describe, expect, it } from 'vitest';
import { apply, createRedact } from '../../src/renderer/editor/model/commands';
import {
  constrainTo45,
  clampRectToImage,
  squareFromAnchor,
} from '../../src/renderer/editor/model/geometry';
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  endGesture,
  MAX_HISTORY,
  redo,
  undo,
} from '../../src/renderer/editor/model/history';
import {
  handlesFor,
  hitHandle,
  hitTest,
  moveAnnotation,
  resizeAnnotation,
  resizeRect,
  textBounds,
} from '../../src/renderer/editor/model/hit-test';
import {
  createDoc,
  exportRect,
  exportSize,
  type Annotation,
  type EditorDoc,
  type TextAnnotation,
} from '../../src/renderer/editor/model/types';

const arrow = (id: string, x0 = 0, y0 = 0, x1 = 100, y1 = 0): Annotation => ({
  type: 'arrow',
  id,
  from: { x: x0, y: y0 },
  to: { x: x1, y: y1 },
  color: '#EF4444',
  width: 4,
});
const rect = (id: string, x = 10, y = 10, w = 50, h = 40): Annotation => ({
  type: 'rect',
  id,
  rect: { x, y, width: w, height: h },
  color: '#3B82F6',
  width: 4,
});
const text = (id: string, at = { x: 20, y: 20 }): TextAnnotation => ({
  type: 'text',
  id,
  at,
  text: 'Hello',
  color: '#fff',
  fontSize: 20,
  fontWeight: 600,
});

const doc = (): EditorDoc => createDoc(400, 300);

describe('apply', () => {
  it('adds, updates, removes and never mutates', () => {
    const base = doc();
    const frozen = JSON.stringify(base);
    const added = apply(base, { type: 'add', annotation: rect('a') });
    expect(JSON.stringify(base)).toBe(frozen);
    expect(added.annotations).toHaveLength(1);
    const moved = apply(added, {
      type: 'update',
      id: 'a',
      patch: { rect: { x: 20, y: 30, width: 5, height: 5 } },
    });
    expect(moved.annotations[0]).toMatchObject({ rect: { x: 20, y: 30 } });
    expect(added.annotations[0]).toMatchObject({ rect: { x: 10, y: 10 } });
    expect(apply(moved, { type: 'remove', id: 'a' }).annotations).toEqual([]);
  });

  it('returns the same document for no-ops and invalid input', () => {
    const base = apply(doc(), { type: 'add', annotation: rect('a') });
    expect(apply(base, { type: 'remove', id: 'nope' })).toBe(base);
    expect(apply(base, { type: 'update', id: 'nope', patch: { width: 3 } })).toBe(base);
    expect(apply(base, { type: 'update', id: 'a', patch: { width: 4 } })).toBe(base);
    expect(apply(base, { type: 'add', annotation: rect('a') })).toBe(base);
    expect(apply(base, { type: 'update', id: 'a', patch: { width: Number.NaN } })).toBe(base);
    expect(apply(base, { type: 'setCrop', crop: null })).toBe(base);
  });

  it('normalizes rectangles with a negative size', () => {
    const next = apply(doc(), {
      type: 'add',
      annotation: { ...rect('a'), rect: { x: 50, y: 50, width: -20, height: -10 } } as Annotation,
    });
    expect(next.annotations[0]).toMatchObject({ rect: { x: 30, y: 40, width: 20, height: 10 } });
  });

  it('reorders within bounds', () => {
    let d = doc();
    for (const id of ['a', 'b', 'c']) d = apply(d, { type: 'add', annotation: rect(id) });
    expect(apply(d, { type: 'reorder', id: 'a', toIndex: 2 }).annotations.map((x) => x.id)).toEqual(
      ['b', 'c', 'a'],
    );
    expect(
      apply(d, { type: 'reorder', id: 'c', toIndex: -5 }).annotations.map((x) => x.id),
    ).toEqual(['c', 'a', 'b']);
    expect(apply(d, { type: 'reorder', id: 'a', toIndex: 0 })).toBe(d);
  });

  it('a redaction has no color or opacity and rejects them from add and update', () => {
    const polluted = {
      ...createRedact('r', { x: 1, y: 2, width: 3, height: 4 }),
      color: '#ff0000',
      opacity: 0.1,
    } as unknown as Annotation;
    let d = apply(doc(), { type: 'add', annotation: polluted });
    expect(d.annotations[0]).toEqual({
      type: 'redact',
      id: 'r',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    d = apply(d, {
      type: 'update',
      id: 'r',
      patch: { color: '#fff', width: 9, rect: { x: 5, y: 6, width: 7, height: 8 } },
    });
    expect(d.annotations[0]).toEqual({
      type: 'redact',
      id: 'r',
      rect: { x: 5, y: 6, width: 7, height: 8 },
    });
    // Only a color patch: nothing changes at all.
    expect(apply(d, { type: 'update', id: 'r', patch: { color: '#fff' } })).toBe(d);
  });
});

describe('crop', () => {
  it('rounds, clamps to the image and keeps annotations in original coordinates', () => {
    let d = apply(doc(), { type: 'add', annotation: rect('a', 300, 200, 40, 40) });
    d = apply(d, { type: 'setCrop', crop: { x: 100.4, y: 50.6, width: 500, height: 100 } });
    expect(d.crop).toEqual({ x: 100, y: 51, width: 300, height: 100 });
    expect(d.annotations[0]).toMatchObject({ rect: { x: 300, y: 200 } });
    expect(exportSize(d)).toEqual({ width: 300, height: 100 });
    expect(exportRect(d)).toEqual({ x: 100, y: 51, width: 300, height: 100 });
  });

  it('the whole image (or nothing left) clears or ignores the crop', () => {
    const cropped = apply(doc(), {
      type: 'setCrop',
      crop: { x: 10, y: 10, width: 50, height: 50 },
    });
    expect(
      apply(cropped, { type: 'setCrop', crop: { x: 0, y: 0, width: 400, height: 300 } }).crop,
    ).toBeNull();
    expect(apply(cropped, { type: 'setCrop', crop: { x: 900, y: 0, width: 10, height: 10 } })).toBe(
      cropped,
    );
    expect(exportSize(doc())).toEqual({ width: 400, height: 300 });
  });

  it('undo and redo restore the crop', () => {
    let h = createHistory(doc());
    h = commit(h, { type: 'setCrop', crop: { x: 10, y: 20, width: 100, height: 80 } });
    expect(h.present.crop).toEqual({ x: 10, y: 20, width: 100, height: 80 });
    h = undo(h);
    expect(h.present.crop).toBeNull();
    h = redo(h);
    expect(h.present.crop).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it('clampRectToImage works from any corner', () => {
    expect(
      clampRectToImage({ x: 50, y: 50, width: -60, height: -60 }, { width: 100, height: 100 }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    });
    expect(
      clampRectToImage({ x: 0, y: 0, width: 0.4, height: 10 }, { width: 100, height: 100 }),
    ).toBeNull();
  });
});

describe('history', () => {
  it('undo / redo and clearing the redo stack on a new edit', () => {
    let h = createHistory(doc());
    expect(canUndo(h)).toBe(false);
    h = commit(h, { type: 'add', annotation: rect('a') });
    h = commit(h, { type: 'add', annotation: rect('b') });
    expect(h.present.annotations).toHaveLength(2);
    h = undo(h);
    expect(h.present.annotations).toHaveLength(1);
    expect(canRedo(h)).toBe(true);
    h = commit(h, { type: 'add', annotation: rect('c') });
    expect(canRedo(h)).toBe(false);
    expect(undo(undo(undo(h))).present.annotations).toHaveLength(0);
  });

  it('coalesces a gesture into one entry and ends it explicitly', () => {
    let h = createHistory(doc());
    h = commit(h, { type: 'add', annotation: rect('a') });
    for (let x = 1; x <= 20; x += 1) {
      h = commit(
        h,
        { type: 'update', id: 'a', patch: { rect: { x, y: 10, width: 50, height: 40 } } },
        'drag-1',
      );
    }
    expect(h.past).toHaveLength(2); // the add, plus ONE entry for the whole drag
    expect(h.present.annotations[0]).toMatchObject({ rect: { x: 20 } });
    h = undo(h);
    expect(h.present.annotations[0]).toMatchObject({ rect: { x: 10 } });
    h = redo(h);
    h = endGesture(h);
    h = commit(
      h,
      { type: 'update', id: 'a', patch: { rect: { x: 99, y: 10, width: 50, height: 40 } } },
      'drag-1',
    );
    expect(h.past).toHaveLength(3); // same key but the gesture had ended: a new entry
  });

  it('a different gesture key starts a new entry', () => {
    let h = createHistory(doc());
    h = commit(h, { type: 'add', annotation: rect('a') });
    h = commit(h, { type: 'update', id: 'a', patch: { width: 6 } }, 'g1');
    h = commit(h, { type: 'update', id: 'a', patch: { width: 7 } }, 'g2');
    expect(h.past).toHaveLength(3);
  });

  it('skips no-op commands', () => {
    const h = createHistory(doc());
    expect(commit(h, { type: 'remove', id: 'zzz' })).toBe(h);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it(`keeps at most ${MAX_HISTORY} undo entries`, () => {
    let h = createHistory(doc());
    for (let i = 0; i < MAX_HISTORY + 50; i += 1) {
      h = commit(h, { type: 'add', annotation: rect(`r${i}`) });
    }
    expect(h.past).toHaveLength(MAX_HISTORY);
    let back = h;
    while (canUndo(back)) back = undo(back);
    expect(back.present.annotations).toHaveLength(50);
  });
});

describe('hit testing', () => {
  it('selects the nearest outline of a rectangle, not its interior', () => {
    const d = apply(doc(), { type: 'add', annotation: rect('a', 100, 100, 100, 80) });
    expect(hitTest(d, { x: 100, y: 140 }, 4)?.id).toBe('a'); // left edge
    expect(hitTest(d, { x: 103, y: 140 }, 4)?.id).toBe('a'); // within tolerance + half stroke
    expect(hitTest(d, { x: 150, y: 140 }, 4)).toBeNull(); // interior
    expect(hitTest(d, { x: 50, y: 50 }, 4)).toBeNull();
  });

  it('hits arrows along the shaft and at the head', () => {
    const d = apply(doc(), { type: 'add', annotation: arrow('a', 0, 0, 100, 0) });
    expect(hitTest(d, { x: 50, y: 3 }, 2)?.id).toBe('a');
    expect(hitTest(d, { x: 50, y: 20 }, 2)).toBeNull();
    expect(hitTest(d, { x: 95, y: 6 }, 2)?.id).toBe('a'); // inside the head
  });

  it('redactions win over everything, even when drawn earlier', () => {
    let d = doc();
    d = apply(d, {
      type: 'add',
      annotation: createRedact('r', { x: 0, y: 0, width: 200, height: 200 }),
    });
    d = apply(d, { type: 'add', annotation: text('t', { x: 10, y: 10 }) });
    expect(hitTest(d, { x: 15, y: 20 }, 2)?.id).toBe('r');
  });

  it('later annotations win over earlier ones', () => {
    let d = doc();
    d = apply(d, { type: 'add', annotation: rect('a', 10, 10, 100, 100) });
    d = apply(d, { type: 'add', annotation: rect('b', 10, 10, 100, 100) });
    expect(hitTest(d, { x: 10, y: 50 }, 3)?.id).toBe('b');
  });

  it('hits text inside its box', () => {
    const d = apply(doc(), { type: 'add', annotation: text('t') });
    const box = textBounds(text('t'));
    expect(hitTest(d, { x: box.x + 2, y: box.y + 2 }, 1)?.id).toBe('t');
    expect(hitTest(d, { x: box.x + box.width + 40, y: box.y }, 1)).toBeNull();
  });
});

describe('handles, move and resize', () => {
  it('rects expose 8 handles, arrows 2, text 1', () => {
    expect(handlesFor(rect('a'))).toHaveLength(8);
    expect(handlesFor(createRedact('r', { x: 0, y: 0, width: 5, height: 5 }))).toHaveLength(8);
    expect(handlesFor(arrow('a')).map((h) => h.id)).toEqual(['from', 'to']);
    expect(handlesFor(text('t')).map((h) => h.id)).toEqual(['se']);
  });

  it('picks the nearest handle within reach', () => {
    const handles = handlesFor(rect('a', 0, 0, 100, 100));
    expect(hitHandle(handles, { x: 98, y: 99 }, 6)?.id).toBe('se');
    expect(hitHandle(handles, { x: 50, y: 50 }, 6)).toBeNull();
  });

  it('resizes from a corner and an edge, and flips past the opposite side', () => {
    const r = { x: 10, y: 10, width: 100, height: 50 };
    expect(resizeRect(r, 'se', { x: 150, y: 90 })).toEqual({
      x: 10,
      y: 10,
      width: 140,
      height: 80,
    });
    expect(resizeRect(r, 'w', { x: 0, y: 999 })).toEqual({ x: 0, y: 10, width: 110, height: 50 });
    expect(resizeRect(r, 'e', { x: -10, y: 0 })).toEqual({ x: -10, y: 10, width: 20, height: 50 });
    expect(resizeRect(r, 'se', { x: 60, y: 200 }, true)).toEqual({
      x: 10,
      y: 10,
      width: 190,
      height: 190,
    });
  });

  it('moves every annotation type', () => {
    expect(moveAnnotation(arrow('a', 0, 0, 10, 10), 5, 6)).toEqual({
      from: { x: 5, y: 6 },
      to: { x: 15, y: 16 },
    });
    expect(moveAnnotation(rect('a'), 1, 2)).toEqual({
      rect: { x: 11, y: 12, width: 50, height: 40 },
    });
    expect(moveAnnotation(text('t'), 3, 4)).toEqual({ at: { x: 23, y: 24 } });
  });

  it('drags arrow endpoints, optionally constrained to 45 degrees', () => {
    const a = arrow('a', 0, 0, 100, 0);
    expect(resizeAnnotation(a, 'to', { x: 50, y: 60 }, false)).toEqual({ to: { x: 50, y: 60 } });
    const patch = resizeAnnotation(a, 'to', { x: 80, y: 70 }, true);
    expect(patch.to?.x).toBeCloseTo(patch.to?.y ?? 0, 6);
    const from = resizeAnnotation(a, 'from', { x: 30, y: 2 }, true);
    expect(from.from?.y).toBeCloseTo(0, 6);
  });

  it('scales text with its corner handle', () => {
    const patch = resizeAnnotation(text('t'), 'se', { x: 0, y: 20 + 25 * 2 }, false);
    expect(patch.fontSize).toBe(40);
  });
});

describe('constraints', () => {
  it('snaps the arrow to multiples of 45 degrees', () => {
    const p = constrainTo45({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.x).toBeCloseTo(Math.hypot(100, 10), 6);
    const d = constrainTo45({ x: 0, y: 0 }, { x: 50, y: 60 });
    expect(d.x).toBeCloseTo(d.y, 6);
    expect(constrainTo45({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });

  it('squares a rectangle in every quadrant', () => {
    expect(squareFromAnchor({ x: 10, y: 10 }, { x: 50, y: 30 })).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 40,
    });
    expect(squareFromAnchor({ x: 10, y: 10 }, { x: -20, y: 15 })).toEqual({
      x: -20,
      y: 10,
      width: 30,
      height: 30,
    });
  });
});
