import { z } from 'zod';
import { apply } from './commands';
import {
  DOC_SCHEMA,
  STAMP_IDS,
  createDoc,
  type Annotation,
  type Beautify,
  type EditorDoc,
} from './types';

/**
 * The editor document as stored in a project (see src/main/projects) and read back. `migrateDoc`
 * accepts a version 1 document (no `schema`: arrow, rect, text, redact only), a version 2 one or a
 * version 3 one (image layers), drops what it does not understand and clamps every number, so a damaged or newer file can never
 * put an invalid element on the canvas.
 */

const num = z.number().finite();
const point = z.object({ x: num, y: num });
const rect = z.object({ x: num, y: num, width: num, height: num });
const color = z.string().min(1).max(64);
const shadow = z.object({ blur: num, offset: num });
const styled = { opacity: num.optional(), shadow: shadow.optional() };
const id = z.string().min(1).max(64);
const head = z.enum(['none', 'triangle', 'open', 'dot']);
const nullableColor = color.nullable().optional();

const annotationSchemas = {
  arrow: z.object({
    id,
    from: point,
    to: point,
    color,
    width: num,
    style: z.enum(['straight', 'curved']).optional(),
    bend: num.optional(),
    startHead: head.optional(),
    endHead: head.optional(),
    ...styled,
  }),
  line: z.object({
    id,
    from: point,
    to: point,
    color,
    width: num,
    dash: z.enum(['solid', 'dashed', 'dotted']).optional(),
    ...styled,
  }),
  rect: z.object({
    id,
    rect,
    color,
    width: num,
    fill: nullableColor,
    fillOpacity: num.optional(),
    radius: num.optional(),
    ...styled,
  }),
  ellipse: z.object({
    id,
    rect,
    color,
    width: num,
    fill: nullableColor,
    fillOpacity: num.optional(),
    ...styled,
  }),
  highlight: z.object({ id, rect, color, opacity: num.optional() }),
  pen: z.object({
    id,
    points: z.array(point).min(1).max(20000),
    color,
    width: num,
    highlighter: z.boolean().optional(),
    ...styled,
  }),
  blur: z.object({ id, rect, mode: z.enum(['blur', 'pixelate']), amount: num }),
  step: z.object({ id, at: point, number: num, color, size: num, ...styled }),
  callout: z.object({
    id,
    rect,
    tail: point,
    text: z.string().max(20000),
    color,
    textColor: color,
    fontSize: num,
    fontWeight: num,
    radius: num.optional(),
    ...styled,
  }),
  text: z.object({
    id,
    at: point,
    text: z.string().max(20000),
    color,
    fontSize: num,
    fontWeight: num,
    family: z.enum(['sans', 'serif', 'mono', 'handwriting']).optional(),
    italic: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    background: nullableColor,
    outlineColor: nullableColor,
    outlineWidth: num.optional(),
    ...styled,
  }),
  spotlight: z.object({
    id,
    rect,
    shape: z.enum(['rect', 'ellipse']),
    dim: num.optional(),
  }),
  magnifier: z.object({ id, rect, zoom: num, color, width: num, ...styled }),
  stamp: z.object({
    id,
    at: point,
    stamp: z.enum(STAMP_IDS),
    size: num,
    color,
    ...styled,
  }),
  ruler: z.object({ id, from: point, to: point, color, width: num, ...styled }),
  image: z.object({
    id,
    rect,
    assetId: z.string().regex(/^[0-9a-f]{64}$/),
    radius: num.optional(),
    ...styled,
  }),
  redact: z.object({ id, rect }),
} as const;

const beautifySchema = z.object({
  background: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('solid'), color }),
    z.object({ kind: z.literal('gradient'), from: color, to: color, angle: num }),
  ]),
  padding: num,
  radius: num,
  shadowBlur: num,
  shadowOffset: num,
  shadowOpacity: num,
});

const cropSchema = rect.nullable().optional();

export interface SerializedDoc {
  schema: number;
  width: number;
  height: number;
  crop: EditorDoc['crop'];
  annotations: Annotation[];
  beautify?: Beautify;
  [key: string]: unknown;
}

/** The document as a plain JSON object to store (carries the schema version). */
export function serializeDoc(doc: EditorDoc): SerializedDoc {
  return {
    schema: DOC_SCHEMA,
    width: doc.width,
    height: doc.height,
    crop: doc.crop,
    annotations: doc.annotations,
    ...(doc.beautify && { beautify: doc.beautify }),
  };
}

export type MigrateResult =
  | { ok: true; doc: EditorDoc; dropped: number }
  | { ok: false; reason: 'not_object' | 'newer_schema' | 'size_mismatch' };

/**
 * Reads a stored document for an image of `width` x `height`. A newer `schema` is refused (the
 * caller falls back to the plain image). Elements that fail validation are dropped and counted.
 */
export function migrateDoc(raw: unknown, size: { width: number; height: number }): MigrateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not_object' };
  }
  const record = raw as Record<string, unknown>;
  const schema = record.schema === undefined ? 1 : record.schema;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    return { ok: false, reason: 'not_object' };
  }
  if (schema > DOC_SCHEMA) return { ok: false, reason: 'newer_schema' };
  if (record.width !== size.width || record.height !== size.height) {
    return { ok: false, reason: 'size_mismatch' };
  }
  let doc = createDoc(size.width, size.height);
  const crop = cropSchema.safeParse(record.crop);
  if (crop.success && crop.data) doc = apply(doc, { type: 'setCrop', crop: crop.data });
  let dropped = 0;
  const list = Array.isArray(record.annotations) ? (record.annotations as unknown[]) : [];
  for (const item of list.slice(0, 5000)) {
    const type =
      typeof item === 'object' && item !== null ? (item as { type?: unknown }).type : undefined;
    const schemaOfType =
      typeof type === 'string' && Object.hasOwn(annotationSchemas, type)
        ? annotationSchemas[type as keyof typeof annotationSchemas]
        : undefined;
    const parsed = schemaOfType?.safeParse(item);
    if (!parsed?.success) {
      dropped += 1;
      continue;
    }
    const next = apply(doc, {
      type: 'add',
      annotation: { ...parsed.data, type } as unknown as Annotation,
    });
    if (next === doc) dropped += 1;
    doc = next;
  }
  if (record.beautify !== undefined && record.beautify !== null) {
    const beautify = beautifySchema.safeParse(record.beautify);
    if (beautify.success) doc = apply(doc, { type: 'setBeautify', beautify: beautify.data });
  }
  return { ok: true, doc, dropped };
}
