import { z } from 'zod';
import { HistoryIdSchema } from './history-ipc';

/**
 * The video editing model, shared by the renderer (the editor) and main (the store and the render
 * graph). Pure: no I/O, no DOM.
 *
 * Every time in a project is a SOURCE time (milliseconds into the recording as it was recorded).
 * Trim, cuts and items never move when something else is edited; only the export maps source time
 * to output time (`sourceToOutput`). New kinds of items (text, images, audio clips) are added to
 * `ItemSchema` and to `normalizeItem` and need no change to the rest of the model.
 */

export const VIDEO_PROJECT_VERSION = 1;

export const MAX_SOURCE_MS = 24 * 60 * 60 * 1000;
export const MAX_SOURCE_PX = 16384;
/** Shortest span an item may have. */
export const MIN_ITEM_MS = 100;
/** Shortest piece of the recording that may be left between cuts (or by a trim). */
export const MIN_SEGMENT_MS = 100;
/** Shortest cut. */
export const MIN_CUT_MS = 50;
/** Smallest box of an item, and smallest crop, in source pixels. */
export const MIN_BOX_PX = 8;
export const MIN_CROP_PX = 16;
export const MAX_ITEMS = 200;
export const MAX_CUTS = 100;
export const MAX_FADE_MS = 10_000;
export const GIF_DEFAULT_FPS = 12;
export const GIF_MAX_FPS = 30;
export const GIF_DEFAULT_WIDTH = 960;
export const DEFAULT_FPS = 30;

// --- schema -----------------------------------------------------------------------------------

const TimeSchema = z.number().int().min(0).max(MAX_SOURCE_MS);
const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const PixelRectSchema = z.strictObject({
  x: z.number().int().min(0).max(MAX_SOURCE_PX),
  y: z.number().int().min(0).max(MAX_SOURCE_PX),
  width: z.number().int().min(1).max(MAX_SOURCE_PX),
  height: z.number().int().min(1).max(MAX_SOURCE_PX),
});
export type PixelRect = z.infer<typeof PixelRectSchema>;

const itemBase = {
  id: IdSchema,
  startMs: TimeSchema,
  endMs: TimeSchema,
  rect: PixelRectSchema,
};

/** A solid box that hides what is under it. */
const RedactItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal('redact'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
const BlurItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal('blur'),
  /** 1 (soft) .. 100 (strong). */
  amount: z.number().int().min(1).max(100),
});
const PixelateItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal('pixelate'),
  /** Side of one pixel block, in source pixels. */
  block: z.number().int().min(2).max(128),
});
/** "Spotlight": everything OUTSIDE the box is dimmed; the box stays as it is. */
const HighlightItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal('highlight'),
  /** How dark the outside gets: 0.1 .. 0.9 of black. */
  dim: z.number().min(0.1).max(0.9),
});

export const ItemSchema = z.discriminatedUnion('kind', [
  RedactItemSchema,
  BlurItemSchema,
  PixelateItemSchema,
  HighlightItemSchema,
]);
export type Item = z.infer<typeof ItemSchema>;
export type ItemKind = Item['kind'];
export const ITEM_KINDS: readonly ItemKind[] = ['redact', 'blur', 'pixelate', 'highlight'];

export const CutSchema = z.strictObject({ id: IdSchema, startMs: TimeSchema, endMs: TimeSchema });
export type Cut = z.infer<typeof CutSchema>;

export const VIDEO_EXPORT_FORMATS = ['mp4', 'webm', 'gif'] as const;
export const VideoExportFormatSchema = z.enum(VIDEO_EXPORT_FORMATS);
export type VideoExportFormat = z.infer<typeof VideoExportFormatSchema>;

export const VideoProjectSchema = z.strictObject({
  version: z.literal(VIDEO_PROJECT_VERSION),
  /** The history item this project edits. */
  sourceId: HistoryIdSchema,
  source: z.strictObject({
    durationMs: z.number().int().min(1).max(MAX_SOURCE_MS),
    width: z.number().int().min(2).max(MAX_SOURCE_PX),
    height: z.number().int().min(2).max(MAX_SOURCE_PX),
    hasAudio: z.boolean(),
    fps: z.number().min(1).max(240).optional(),
  }),
  trim: z.strictObject({ startMs: TimeSchema, endMs: TimeSchema }),
  cuts: z.array(CutSchema).max(MAX_CUTS),
  crop: PixelRectSchema.nullable(),
  items: z.array(ItemSchema).max(MAX_ITEMS),
  audio: z.strictObject({ volume: z.number().min(0).max(2), muted: z.boolean() }),
  fadeInMs: z.number().int().min(0).max(MAX_FADE_MS),
  fadeOutMs: z.number().int().min(0).max(MAX_FADE_MS),
  export: z.strictObject({
    format: VideoExportFormatSchema,
    /** Widest the output may be (pixels); absent: the cropped size. */
    scale: z.number().int().min(160).max(7680).optional(),
    gifFps: z.number().int().min(1).max(GIF_MAX_FPS).optional(),
  }),
});
export type VideoProject = z.infer<typeof VideoProjectSchema>;
export type VideoSource = VideoProject['source'];

/** A saved project is at most this big (JSON); main refuses more. */
export const MAX_VIDEO_PROJECT_BYTES = 512 * 1024;

// --- segments and time mapping ----------------------------------------------------------------

export interface Segment {
  startMs: number;
  endMs: number;
}

/**
 * The cuts clamped to the trim, merged where they overlap or touch, and widened over any sliver of
 * video shorter than MIN_SEGMENT_MS that they would leave. Cuts that are shorter than MIN_CUT_MS or
 * outside the trim are dropped. A merged cut keeps the id of its first part.
 */
export function normalizeCuts(trim: Segment, cuts: readonly Cut[]): Cut[] {
  const clamped = cuts
    .map((cut) => ({
      id: cut.id,
      startMs: Math.max(trim.startMs, Math.min(trim.endMs, Math.round(cut.startMs))),
      endMs: Math.max(trim.startMs, Math.min(trim.endMs, Math.round(cut.endMs))),
    }))
    .filter((cut) => cut.endMs - cut.startMs >= MIN_CUT_MS)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Cut[] = [];
  for (const cut of clamped) {
    const last = merged[merged.length - 1];
    // A gap smaller than a segment is not worth keeping: the two cuts become one.
    if (last && cut.startMs - last.endMs < MIN_SEGMENT_MS) {
      last.endMs = Math.max(last.endMs, cut.endMs);
    } else {
      merged.push({ ...cut });
    }
  }
  const first = merged[0];
  if (first && first.startMs - trim.startMs < MIN_SEGMENT_MS) first.startMs = trim.startMs;
  const last = merged[merged.length - 1];
  if (last && trim.endMs - last.endMs < MIN_SEGMENT_MS) last.endMs = trim.endMs;
  return merged;
}

/** The pieces of the recording that stay: the trim minus the cuts, in order. Empty if nothing stays. */
export function keptSegments(trim: Segment, cuts: readonly Cut[]): Segment[] {
  const segments: Segment[] = [];
  let at = trim.startMs;
  for (const cut of normalizeCuts(trim, cuts)) {
    if (cut.startMs > at) segments.push({ startMs: at, endMs: cut.startMs });
    at = Math.max(at, cut.endMs);
  }
  if (trim.endMs > at) segments.push({ startMs: at, endMs: trim.endMs });
  return segments;
}

export function projectSegments(project: Pick<VideoProject, 'trim' | 'cuts'>): Segment[] {
  return keptSegments(project.trim, project.cuts);
}

export function outputDurationMs(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0);
}

/**
 * Output time of a source time. A time inside a cut maps to where the cut starts in the output; a
 * time before the first piece maps to 0 and one after the last to the output duration.
 */
export function sourceToOutput(segments: readonly Segment[], sourceMs: number): number {
  let output = 0;
  for (const segment of segments) {
    if (sourceMs < segment.startMs) return output;
    if (sourceMs < segment.endMs) return output + (sourceMs - segment.startMs);
    output += segment.endMs - segment.startMs;
  }
  return output;
}

/** Source time of an output time (clamped to the output). The end maps to the end of the last piece. */
export function outputToSource(segments: readonly Segment[], outputMs: number): number {
  const last = segments[segments.length - 1];
  if (!last) return 0;
  let remaining = Math.max(0, outputMs);
  for (const segment of segments) {
    const length = segment.endMs - segment.startMs;
    if (remaining < length) return segment.startMs + remaining;
    remaining -= length;
  }
  return last.endMs;
}

/** The piece that contains a source time, or the next one after it (what playback jumps to). */
export function segmentAtOrAfter(segments: readonly Segment[], sourceMs: number): Segment | null {
  return segments.find((segment) => sourceMs < segment.endMs) ?? null;
}

// --- output geometry --------------------------------------------------------------------------

const even = (value: number): number => Math.max(2, value - (value % 2));

export interface OutputGeometry {
  /** The picture the graph crops to (before scaling): even sizes. */
  cropped: PixelRect;
  width: number;
  height: number;
}

/** Cropped size and final size (even numbers, scaled down to the max width when one is set). */
export function outputGeometry(
  project: Pick<VideoProject, 'source' | 'crop' | 'export'>,
): OutputGeometry {
  const area = project.crop ?? {
    x: 0,
    y: 0,
    width: project.source.width,
    height: project.source.height,
  };
  const cropped = {
    x: area.x - (area.x % 2),
    y: area.y - (area.y % 2),
    width: even(area.width),
    height: even(area.height),
  };
  const limit =
    project.export.format === 'gif'
      ? (project.export.scale ?? GIF_DEFAULT_WIDTH)
      : project.export.scale;
  if (limit === undefined || limit >= cropped.width) {
    return { cropped, width: cropped.width, height: cropped.height };
  }
  const width = even(limit);
  return { cropped, width, height: even(Math.round((cropped.height * width) / cropped.width)) };
}

// --- creating and normalizing -----------------------------------------------------------------

export function createProject(sourceId: string, source: VideoSource): VideoProject {
  return {
    version: VIDEO_PROJECT_VERSION,
    sourceId,
    source,
    trim: { startMs: 0, endMs: source.durationMs },
    cuts: [],
    crop: null,
    items: [],
    audio: { volume: 1, muted: false },
    fadeInMs: 0,
    fadeOutMs: 0,
    export: { format: 'mp4' },
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const round = (value: number): number => Math.round(Number.isFinite(value) ? value : 0);

export function normalizeRect(
  rect: PixelRect,
  source: Pick<VideoSource, 'width' | 'height'>,
  min: number,
): PixelRect {
  const width = clamp(round(rect.width), Math.min(min, source.width), source.width);
  const height = clamp(round(rect.height), Math.min(min, source.height), source.height);
  return {
    x: clamp(round(rect.x), 0, source.width - width),
    y: clamp(round(rect.y), 0, source.height - height),
    width,
    height,
  };
}

/** An item with every number inside the source and the right fields for its kind. */
export function normalizeItem(item: Item, source: VideoSource): Item {
  let startMs = clamp(round(item.startMs), 0, source.durationMs);
  let endMs = clamp(round(item.endMs), 0, source.durationMs);
  if (endMs - startMs < MIN_ITEM_MS) {
    const length = Math.min(MIN_ITEM_MS, source.durationMs);
    endMs = Math.min(source.durationMs, startMs + length);
    startMs = endMs - length;
  }
  const base = { id: item.id, startMs, endMs, rect: normalizeRect(item.rect, source, MIN_BOX_PX) };
  switch (item.kind) {
    case 'redact':
      return { ...base, kind: 'redact', color: item.color };
    case 'blur':
      return { ...base, kind: 'blur', amount: clamp(round(item.amount), 1, 100) };
    case 'pixelate':
      return { ...base, kind: 'pixelate', block: clamp(round(item.block), 2, 128) };
    case 'highlight':
      return { ...base, kind: 'highlight', dim: clamp(item.dim, 0.1, 0.9) };
  }
}

/** A crop inside the source, even-aligned and at least MIN_CROP_PX; the whole frame is "no crop". */
export function normalizeCrop(crop: PixelRect | null, source: VideoSource): PixelRect | null {
  if (!crop) return null;
  const rect = normalizeRect(crop, source, MIN_CROP_PX);
  const aligned = {
    x: rect.x - (rect.x % 2),
    y: rect.y - (rect.y % 2),
    width: even(rect.width),
    height: even(rect.height),
  };
  aligned.width = Math.min(aligned.width, even(source.width) - aligned.x);
  aligned.height = Math.min(aligned.height, even(source.height) - aligned.y);
  const whole =
    aligned.x === 0 &&
    aligned.y === 0 &&
    aligned.width >= even(source.width) &&
    aligned.height >= even(source.height);
  return whole ? null : aligned;
}

/**
 * The project made valid again: every value inside the source, trim and cuts consistent (cuts that
 * would remove everything are dropped), fades no longer than the output. Never throws. The shape
 * itself (types, ranges) is the schema's job.
 */
export function normalizeProject(project: VideoProject): VideoProject {
  const { source } = project;
  const minSpan = Math.min(MIN_SEGMENT_MS, source.durationMs);
  const startMs = clamp(round(project.trim.startMs), 0, source.durationMs - minSpan);
  const endMs = clamp(round(project.trim.endMs), startMs + minSpan, source.durationMs);
  const trim = { startMs, endMs };
  let cuts = normalizeCuts(trim, project.cuts);
  if (keptSegments(trim, cuts).length === 0) cuts = [];
  const total = outputDurationMs(keptSegments(trim, cuts));
  const fadeInMs = clamp(round(project.fadeInMs), 0, Math.min(MAX_FADE_MS, total));
  const fadeOutMs = clamp(round(project.fadeOutMs), 0, Math.min(MAX_FADE_MS, total - fadeInMs));
  return {
    ...project,
    trim,
    cuts,
    crop: normalizeCrop(project.crop, source),
    items: project.items.map((item) => normalizeItem(item, source)),
    audio: { volume: clamp(project.audio.volume, 0, 2), muted: project.audio.muted },
    fadeInMs,
    fadeOutMs,
  };
}

/** Parses untrusted data (a saved file, an IPC payload) into a normalized project; null if invalid. */
export function parseProject(data: unknown): VideoProject | null {
  const parsed = VideoProjectSchema.safeParse(data);
  return parsed.success ? normalizeProject(parsed.data) : null;
}

// --- default items ----------------------------------------------------------------------------

export function newItem(
  kind: ItemKind,
  id: string,
  rect: PixelRect,
  startMs: number,
  endMs: number,
): Item {
  const base = { id, startMs, endMs, rect };
  switch (kind) {
    case 'redact':
      return { ...base, kind, color: '#000000' };
    case 'blur':
      return { ...base, kind, amount: 40 };
    case 'pixelate':
      return { ...base, kind, block: 16 };
    case 'highlight':
      return { ...base, kind, dim: 0.6 };
  }
}

// --- commands ---------------------------------------------------------------------------------

export type ItemPatch = Partial<{
  startMs: number;
  endMs: number;
  rect: PixelRect;
  color: string;
  amount: number;
  block: number;
  dim: number;
}>;

export type VideoCommand =
  | { type: 'addItem'; item: Item }
  | { type: 'updateItem'; id: string; patch: ItemPatch }
  | { type: 'removeItem'; id: string }
  | { type: 'setTrim'; startMs: number; endMs: number }
  /** "Cut selection": removes the time range from the output. */
  | { type: 'addCut'; id: string; startMs: number; endMs: number }
  | { type: 'removeCut'; id: string }
  | { type: 'setCrop'; crop: PixelRect | null }
  | { type: 'setAudio'; patch: Partial<VideoProject['audio']> }
  | { type: 'setFades'; fadeInMs?: number; fadeOutMs?: number }
  | { type: 'setExport'; patch: Partial<VideoProject['export']> };

/** Applies a command. A command that changes nothing returns the same project object. */
export function applyCommand(project: VideoProject, command: VideoCommand): VideoProject {
  const next = reduce(project, command);
  if (next === project) return project;
  const normalized = normalizeProject(next);
  return JSON.stringify(normalized) === JSON.stringify(project) ? project : normalized;
}

function reduce(project: VideoProject, command: VideoCommand): VideoProject {
  switch (command.type) {
    case 'addItem':
      if (project.items.length >= MAX_ITEMS) return project;
      if (project.items.some((item) => item.id === command.item.id)) return project;
      return { ...project, items: [...project.items, command.item] };
    case 'updateItem': {
      if (!project.items.some((item) => item.id === command.id)) return project;
      const items = project.items.map((item) =>
        item.id === command.id ? patchItem(item, command.patch) : item,
      );
      return { ...project, items };
    }
    case 'removeItem':
      return { ...project, items: project.items.filter((item) => item.id !== command.id) };
    case 'setTrim':
      return { ...project, trim: { startMs: command.startMs, endMs: command.endMs } };
    case 'addCut': {
      if (project.cuts.length >= MAX_CUTS) return project;
      const cuts = [
        ...project.cuts.filter((cut) => cut.id !== command.id),
        { id: command.id, startMs: command.startMs, endMs: command.endMs },
      ];
      // A cut that would remove everything that is left is refused.
      if (keptSegments(project.trim, cuts).length === 0) return project;
      return { ...project, cuts };
    }
    case 'removeCut':
      return { ...project, cuts: project.cuts.filter((cut) => cut.id !== command.id) };
    case 'setCrop':
      return { ...project, crop: command.crop };
    case 'setAudio':
      return { ...project, audio: { ...project.audio, ...command.patch } };
    case 'setFades':
      return {
        ...project,
        fadeInMs: command.fadeInMs ?? project.fadeInMs,
        fadeOutMs: command.fadeOutMs ?? project.fadeOutMs,
      };
    case 'setExport': {
      const merged = { ...project.export, ...command.patch };
      // `undefined` clears an option (exactOptionalPropertyTypes: the key must go, not be undefined).
      const { scale, gifFps, format } = merged;
      return {
        ...project,
        export: {
          format,
          ...(scale !== undefined && { scale }),
          ...(gifFps !== undefined && { gifFps }),
        },
      };
    }
  }
}

function patchItem(item: Item, patch: ItemPatch): Item {
  const common = {
    startMs: patch.startMs ?? item.startMs,
    endMs: patch.endMs ?? item.endMs,
    rect: patch.rect ?? item.rect,
  };
  switch (item.kind) {
    case 'redact':
      return { ...item, ...common, color: patch.color ?? item.color };
    case 'blur':
      return { ...item, ...common, amount: patch.amount ?? item.amount };
    case 'pixelate':
      return { ...item, ...common, block: patch.block ?? item.block };
    case 'highlight':
      return { ...item, ...common, dim: patch.dim ?? item.dim };
  }
}
