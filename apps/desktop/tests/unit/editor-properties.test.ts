import { describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/renderer/editor/model/commands';
import {
  draftFor,
  isDraftBigEnough,
  penDraft,
  simplifyStroke,
  stampAt,
  stepAt,
  textDraft,
  type DragTool,
} from '../../src/renderer/editor/model/create';
import { serializeDoc } from '../../src/renderer/editor/model/migrate';
import { createDoc, type Annotation, type EditorDoc } from '../../src/renderer/editor/model/types';
import { initialStyle } from '../../src/renderer/editor/presets';
import { applyProp, propsOf, supportFor, typeForTool } from '../../src/renderer/editor/properties';
import { FLATTENED_LABEL, openFromHistory } from '../../src/renderer/editor/reedit';

const image = { width: 1600, height: 900 };
const style = initialStyle(image);

describe('the starting style scales with the capture', () => {
  it('uses larger strokes and text on a big capture', () => {
    const big = initialStyle({ width: 3600, height: 2000 });
    expect(big.strokeWidth).toBeGreaterThan(initialStyle({ width: 800, height: 600 }).strokeWidth);
    expect(big.fontSize).toBeGreaterThan(initialStyle({ width: 800, height: 600 }).fontSize);
  });
});

describe('making elements from drags and clicks', () => {
  const tools: DragTool[] = [
    'rect',
    'ellipse',
    'line',
    'arrow',
    'highlight',
    'blur',
    'redact',
    'spotlight',
    'magnifier',
    'ruler',
    'callout',
  ];
  it.each(tools)(
    '%s: a drag makes a valid element of that type, accepted by the reducer',
    (name) => {
      const draft = draftFor(name, 'id', { x: 100, y: 100 }, { x: 300, y: 220 }, false, style);
      expect(draft.type).toBe(name);
      const next = apply(createDoc(1600, 900), {
        type: 'add',
        annotation: name === 'callout' ? ({ ...draft, text: 'Hi' } as Annotation) : draft,
      });
      expect(next.annotations).toHaveLength(1);
    },
  );

  it('Shift makes squares, circles and 45 degree lines', () => {
    const square = draftFor('rect', 'a', { x: 0, y: 0 }, { x: 100, y: 40 }, true, style);
    expect(square.type === 'rect' && square.rect.width === square.rect.height).toBe(true);
    const line = draftFor('line', 'b', { x: 0, y: 0 }, { x: 100, y: 30 }, true, style);
    expect(line.type === 'line' && Math.abs(line.to.y)).toBeCloseTo(0, 6);
  });

  it('a redaction made by dragging has no color or opacity, whatever the style says', () => {
    const redact = draftFor('redact', 'r', { x: 0, y: 0 }, { x: 50, y: 50 }, false, {
      ...style,
      color: '#00ff00',
      opacity: 0.2,
    });
    expect(redact).toEqual({
      type: 'redact',
      id: 'r',
      rect: { x: 0, y: 0, width: 50, height: 50 },
    });
  });

  it('style choices carry into new elements', () => {
    const rect = draftFor('rect', 'a', { x: 0, y: 0 }, { x: 90, y: 60 }, false, {
      ...style,
      fill: '#112233',
      fillOpacity: 0.5,
      radius: 12,
      opacity: 0.8,
      shadow: { blur: 6, offset: 3 },
    });
    expect(rect).toMatchObject({
      fill: '#112233',
      fillOpacity: 0.5,
      radius: 12,
      opacity: 0.8,
      shadow: { blur: 6, offset: 3 },
    });
    const arrow = draftFor('arrow', 'b', { x: 0, y: 0 }, { x: 90, y: 60 }, false, {
      ...style,
      arrowStyle: 'curved',
      startHead: 'dot',
      endHead: 'open',
    });
    expect(arrow).toMatchObject({ style: 'curved', startHead: 'dot', endHead: 'open' });
    expect(
      textDraft('t', { x: 1, y: 2 }, { ...style, family: 'mono', italic: true, align: 'center' }),
    ).toMatchObject({
      family: 'mono',
      italic: true,
      align: 'center',
    });
  });

  it('steps take the counter, stamps the chosen glyph', () => {
    expect(stepAt('s', { x: 5, y: 5 }, { ...style, stepNumber: 4 })).toMatchObject({ number: 4 });
    expect(stampAt('t', { x: 5, y: 5 }, 'heart', style)).toMatchObject({ stamp: 'heart' });
  });

  it('a click is not a drag: tiny drags are dropped', () => {
    const draft = draftFor('rect', 'a', { x: 0, y: 0 }, { x: 2, y: 2 }, false, style);
    expect(isDraftBigEnough(draft, 1, 4)).toBe(false);
    expect(
      isDraftBigEnough(draftFor('rect', 'a', { x: 0, y: 0 }, { x: 50, y: 50 }, false, style), 1, 4),
    ).toBe(true);
    expect(
      isDraftBigEnough(draftFor('line', 'a', { x: 0, y: 0 }, { x: 3, y: 0 }, false, style), 1, 4),
    ).toBe(false);
  });
});

describe('freehand strokes', () => {
  it('thins a long stroke but keeps its ends and its corners', () => {
    const points = [];
    for (let x = 0; x <= 200; x += 1) points.push({ x, y: 0 });
    for (let y = 1; y <= 200; y += 1) points.push({ x: 200, y });
    const thin = simplifyStroke(points, 1);
    expect(thin.length).toBeLessThanOrEqual(5);
    expect(thin[0]).toEqual({ x: 0, y: 0 });
    expect(thin[thin.length - 1]).toEqual({ x: 200, y: 200 });
    expect(thin).toContainEqual({ x: 200, y: 0 });
    expect(simplifyStroke([{ x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }]);
  });

  it('a highlighter stroke is wide and multiplies; a pen follows the style', () => {
    const marker = penDraft(
      'p',
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ],
      style,
      true,
    );
    expect(marker).toMatchObject({ highlighter: true });
    expect(marker.type === 'pen' && marker.width).toBeGreaterThanOrEqual(14);
    expect(penDraft('q', [{ x: 0, y: 0 }], { ...style, color: '#123456' }, false)).toMatchObject({
      color: '#123456',
    });
  });

  it('caps a document stroke at the model limit', () => {
    const many = Array.from({ length: 6000 }, (_, i) => ({ x: i, y: (i * 7) % 50 }));
    const d = apply(createDoc(8000, 100), {
      type: 'add',
      annotation: penDraft('p', many, style, false),
    });
    expect((d.annotations[0] as { points: unknown[] }).points).toHaveLength(4000);
  });
});

describe('the properties panel mapping', () => {
  it('shows the selection, falling back to the style', () => {
    expect(propsOf(null, style).color).toBe(style.color);
    const rect: Annotation = {
      type: 'rect',
      id: 'r',
      rect: { x: 0, y: 0, width: 5, height: 5 },
      color: '#abcdef',
      width: 9,
      fill: '#111111',
      radius: 4,
    };
    expect(propsOf(rect, style)).toMatchObject({
      color: '#abcdef',
      strokeWidth: 9,
      fill: '#111111',
      fillOpacity: 1,
      radius: 4,
      shadow: null,
    });
    const blur: Annotation = {
      type: 'blur',
      id: 'b',
      rect: { x: 0, y: 0, width: 5, height: 5 },
      mode: 'pixelate',
      amount: 17,
    };
    expect(propsOf(blur, style)).toMatchObject({ blurMode: 'pixelate', blurAmount: 17 });
  });

  it('a change updates both the style and the patch, with the right names', () => {
    const fill = applyProp('fill', '#ff0000', style, 'rect');
    expect(fill.style.fill).toBe('#ff0000');
    expect(fill.patch).toEqual({ fill: '#ff0000', fillOpacity: style.fillOpacity });
    expect(applyProp('strokeWidth', 11, style, 'arrow').patch).toEqual({ width: 11 });
    expect(applyProp('arrowStyle', 'curved', style, 'arrow').patch).toEqual({ style: 'curved' });
    expect(applyProp('blurAmount', 30, style, 'blur')).toMatchObject({
      patch: { amount: 30 },
      style: { blurAmount: 30 },
    });
    expect(applyProp('shadow', null, style, 'rect').patch).toEqual({ shadow: null });
    // Step numbers and mark sizes change the selection only, never the defaults.
    expect(applyProp('stepNumber', 9, style, 'step').style.stepNumber).toBe(style.stepNumber);
  });

  it('colors go where they belong: highlighter and bubble keep their own', () => {
    expect(applyProp('color', '#00ff00', style, 'highlight').style).toMatchObject({
      highlightColor: '#00ff00',
      color: style.color,
    });
    expect(applyProp('color', '#00ff00', style, 'callout').style).toMatchObject({
      calloutColor: '#00ff00',
      color: style.color,
    });
  });

  it('a patch from the panel edits a real element and ignores fields it does not have', () => {
    let doc: EditorDoc = createDoc(400, 300);
    doc = apply(doc, {
      type: 'add',
      annotation: draftFor('ellipse', 'e', { x: 10, y: 10 }, { x: 110, y: 70 }, false, style),
    });
    const edit = applyProp('fill', '#00aaff', style, 'ellipse');
    doc = apply(doc, { type: 'update', id: 'e', patch: edit.patch });
    expect(doc.annotations[0]).toMatchObject({ fill: '#00aaff' });
    // A corner radius means nothing to an ellipse: no change at all.
    const same = apply(doc, {
      type: 'update',
      id: 'e',
      patch: applyProp('radius', 20, style, 'ellipse').patch,
    });
    expect(same).toBe(doc);
  });

  it('knows which controls each element has', () => {
    expect(supportFor('redact')).toMatchObject({ color: false, stroke: false, opacity: false });
    expect(supportFor('rect')).toMatchObject({ fill: true, radius: true, shadow: true });
    expect(supportFor('blur')).toMatchObject({ blur: true, color: false });
    expect(supportFor(null).color).toBe(false);
    expect(typeForTool('select')).toBeNull();
    expect(typeForTool('step')).toBe('step');
  });
});

describe('opening a screenshot from History', () => {
  const session = { id: 's1', kind: 'region', width: 400, height: 300, createdAt: 1 };
  const response = (edit: Record<string, unknown>) => ({
    ok: true as const,
    data: {
      session,
      png: new ArrayBuffer(8),
      edit: {
        historyId: 'h1',
        format: 'png',
        mode: 'project',
        doc: null,
        notice: null,
        canSave: true,
        ...edit,
      },
    },
  });
  const open = (invoke: ReturnType<typeof vi.fn>) =>
    openFromHistory({ invoke } as unknown as Parameters<typeof openFromHistory>[0], 'h1');

  it('returns the migrated annotations in project mode', async () => {
    const doc = apply(createDoc(400, 300), {
      type: 'add',
      annotation: draftFor('rect', 'a', { x: 5, y: 5 }, { x: 80, y: 60 }, false, style),
    });
    const invoke = vi.fn().mockResolvedValue(response({ doc: serializeDoc(doc) }));
    const result = await open(invoke);
    expect(result.ok && result.shot.edit.mode).toBe('project');
    expect(result.ok && result.shot.edit.doc?.annotations).toHaveLength(1);
    expect(result.ok && result.shot.edit.notice).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a plain old item opens as a flattened copy with the label', async () => {
    const result = await open(
      vi.fn().mockResolvedValue(response({ mode: 'flattened', doc: null })),
    );
    expect(result.ok && result.shot.edit).toMatchObject({
      mode: 'flattened',
      doc: null,
      notice: FLATTENED_LABEL,
    });
  });

  it.each([
    ['a newer schema', { schema: 99, width: 400, height: 300, annotations: [] }],
    ['the wrong size', { schema: 2, width: 10, height: 10, annotations: [] }],
    [
      'a damaged mark (could be a redaction)',
      {
        schema: 2,
        width: 400,
        height: 300,
        annotations: [{ type: 'redact', id: 'x', rect: 'oops' }],
      },
    ],
  ])('%s: the session is dropped and the saved image opens instead', async (_name, doc) => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(response({ doc }))
      .mockResolvedValueOnce(undefined) // shot:discard
      .mockResolvedValueOnce(response({ mode: 'flattened', doc: null }));
    const result = await open(invoke);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'shot:openFromHistory',
      'shot:discard',
      'shot:openFromHistory',
    ]);
    expect(invoke.mock.calls[2]?.[1]).toEqual({ historyId: 'h1', flattened: true });
    expect(result.ok && result.shot.edit.mode).toBe('flattened');
    expect(result.ok && result.shot.edit.notice).toContain(FLATTENED_LABEL);
  });

  it('passes a refusal on (not found, locked...)', async () => {
    const refused = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } });
    expect(await open(refused)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'gone' },
    });
  });
});
