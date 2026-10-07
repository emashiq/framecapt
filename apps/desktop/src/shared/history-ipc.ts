import { z } from 'zod';
import {
  COMPRESSION_LEVELS,
  MAX_OUTPUT_WIDTH,
  MIN_OUTPUT_WIDTH,
  SAVE_FORMATS,
} from './recording-format';
import { RecordingLayoutSchema } from './recording-layout';

/** History ids are random uuids made by main; the renderer only ever sends them back. */
export const HISTORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HistoryIdSchema = z.string().regex(HISTORY_ID_PATTERN);

export const HistoryTypeSchema = z.enum(['screenshot', 'recording', 'flow']);
export type HistoryType = z.infer<typeof HistoryTypeSchema>;

export const HistorySourceSchema = z.enum(['screen', 'window', 'region', 'multi', 'unknown']);
export type HistorySource = z.infer<typeof HistorySourceSchema>;

export const HISTORY_FORMATS = [
  'png',
  'jpeg',
  'webm',
  'mp4',
  'mkv',
  'fcap',
  'gif',
  'flow',
] as const;
export const HistoryFormatSchema = z.enum(HISTORY_FORMATS);
export type HistoryFormat = z.infer<typeof HistoryFormatSchema>;

/** Largest thumbnail main accepts from the editor, and the widest it may be. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const MAX_THUMBNAIL_WIDTH = 480;
/** Largest image `history:copyImage` reads into the clipboard. */
export const MAX_COPY_IMAGE_BYTES = 200 * 1024 * 1024;

/** One entry as the renderer sees it: facts about a file FrameCapt produced, plus whether it still exists. */
export const HistoryItemViewSchema = z.object({
  id: HistoryIdSchema,
  type: HistoryTypeSchema,
  createdAt: z.number(),
  /** Absolute path, shown to the user. Never sent back: every action goes by `id`. */
  path: z.string(),
  fileName: z.string(),
  width: z.number(),
  height: z.number(),
  durationMs: z.number().nullable(),
  sizeBytes: z.number(),
  format: HistoryFormatSchema,
  hasThumb: z.boolean(),
  hasAudio: z.boolean().nullable(),
  source: HistorySourceSchema,
  /** The history item this MP4 was converted from. */
  derivedFrom: HistoryIdSchema.nullable(),
  /** False when the file was moved or deleted outside FrameCapt. */
  exists: z.boolean(),
  /** An editable project (the unredacted original and the annotations) is stored for this item. */
  editable: z.boolean(),
  /** `.fcap` recordings: where each source sits in the picture (read from the file's header). */
  layout: RecordingLayoutSchema.nullable().optional(),
  /** Steps of a step guide (type `flow`); absent for everything else. */
  stepCount: z.number().int().min(0).optional(),
  /** The library folder the file sits in (`Clients/Acme`); absent = the library root. */
  folder: z.string().optional(),
  /** The file is outside both capture folders ("Other locations"). */
  outside: z.boolean().optional(),
});
export type HistoryItemView = z.infer<typeof HistoryItemViewSchema>;

export const HistoryListRequestSchema = z.strictObject({
  filter: HistoryTypeSchema.optional(),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type HistoryListRequest = z.infer<typeof HistoryListRequestSchema>;

export const HistoryListResponseSchema = z.object({
  items: z.array(HistoryItemViewSchema),
  /** Items in history before the filter, query and limit. */
  total: z.number(),
});
export type HistoryListResponse = z.infer<typeof HistoryListResponseSchema>;

export const HistoryIdRequestSchema = z.strictObject({ id: HistoryIdSchema });

export const HistoryCancelledSchema = z.object({ cancelled: z.literal(true) });

// --- MP4 export -------------------------------------------------------------------------------

export const ExportCapabilitiesSchema = z.object({
  mp4Available: z.boolean(),
  /** libvpx-vp9 + libopus: WebM can be produced (re-encoded). Absent in answers of older builds: assume true. */
  webmAvailable: z.boolean().optional(),
  /** The GIF encoder is present. */
  gifAvailable: z.boolean().optional(),
  reason: z.string().optional(),
});
export type ExportCapabilities = z.infer<typeof ExportCapabilitiesSchema>;

export const ExportMp4RequestSchema = z.strictObject({ historyId: HistoryIdSchema });
export const ExportMp4ResponseSchema = z.union([
  z.strictObject({ jobId: z.string() }),
  HistoryCancelledSchema,
]);
export const ExportCancelRequestSchema = z.strictObject({ jobId: z.string().min(1).max(64) });

/**
 * What the job is: the user's MP4 export (default), the post-save format/compression job that
 * replaces the recording's file, a "Save as…" copy, a `.fcap` extract or a step-guide slideshow.
 */
const ExportKindSchema = z.enum(['export', 'compress', 'convert', 'extract', 'guide']).optional();

export const ExportProgressEventSchema = z.object({
  kind: ExportKindSchema,
  jobId: z.string(),
  historyId: HistoryIdSchema,
  /** 0..99 while encoding; null when the length of the recording is not known. */
  percent: z.number().nullable(),
});
export const ExportDoneEventSchema = z.object({
  kind: ExportKindSchema,
  jobId: z.string(),
  historyId: HistoryIdSchema,
  path: z.string(),
  /** The history item of the new MP4 (null when it could not be added). */
  itemId: HistoryIdSchema.nullable(),
});
export const ExportFailedEventSchema = z.object({
  kind: ExportKindSchema,
  jobId: z.string(),
  historyId: HistoryIdSchema,
  code: z.string(),
  message: z.string(),
  cancelled: z.boolean(),
});
export type ExportProgressEvent = z.infer<typeof ExportProgressEventSchema>;
export type ExportDoneEvent = z.infer<typeof ExportDoneEventSchema>;
export type ExportFailedEvent = z.infer<typeof ExportFailedEventSchema>;

// --- Save as… (a new file in another format) -------------------------------------------------

/** `history:saveAs`: a copy of a recording in another format; the source is never replaced. */
export const SaveAsRequestSchema = z.strictObject({
  id: HistoryIdSchema,
  format: z.enum(SAVE_FORMATS),
  compression: z.enum(COMPRESSION_LEVELS),
  /** The picture is made at most this wide (never larger than the source). Absent: keep the size. */
  maxWidth: z.number().int().min(MIN_OUTPUT_WIDTH).max(MAX_OUTPUT_WIDTH).optional(),
});
export type SaveAsRequest = z.infer<typeof SaveAsRequestSchema>;
export const SaveAsResponseSchema = z.strictObject({ jobId: z.string() });

// --- extracting from a multi-source recording ---------------------------------------------------

export const EXTRACT_FORMATS = ['mp4', 'webm'] as const;
export type ExtractFormat = (typeof EXTRACT_FORMATS)[number];

/** `history:extractFcap`: one source (or null: the whole picture) of a `.fcap`, between two times. */
export const ExtractFcapRequestSchema = z
  .strictObject({
    id: HistoryIdSchema,
    sourceIndex: z.number().int().min(0).max(3).nullable(),
    startMs: z.number().int().min(0).max(86_400_000),
    endMs: z.number().int().min(1).max(86_400_000),
    format: z.enum(EXTRACT_FORMATS),
  })
  .refine((request) => request.endMs > request.startMs, {
    message: 'The end must be after the start.',
    path: ['endMs'],
  });
export type ExtractFcapRequest = z.infer<typeof ExtractFcapRequestSchema>;
export const ExtractFcapResponseSchema = z.strictObject({ jobId: z.string() });

// --- bulk save of copies and drag-out ---------------------------------------------------------

/** Most items one "Save copies" run takes (the grid never holds more than the history limit). */
export const MAX_BULK_ITEMS = 500;

export const BulkExportRequestSchema = z.strictObject({
  ids: z.array(HistoryIdSchema).min(1).max(MAX_BULK_ITEMS),
});

export const BulkItemResultSchema = z.object({
  id: HistoryIdSchema,
  status: z.enum(['saved', 'failed', 'skipped']),
  /** The name the copy got (saved only). */
  fileName: z.string().optional(),
  /** The full path of the copy (saved only), so "Show in folder" can select it. */
  path: z.string().optional(),
  /** Why an item failed or was skipped. */
  message: z.string().optional(),
});
export type BulkItemResult = z.infer<typeof BulkItemResultSchema>;

export const BulkExportDoneSchema = z.object({
  folder: z.string(),
  /** The user cancelled while copying: the items after that point are `skipped`. */
  cancelled: z.boolean(),
  results: z.array(BulkItemResultSchema),
});
export type BulkExportDone = z.infer<typeof BulkExportDoneSchema>;

/** The folder dialog was cancelled (nothing happened), or the run finished. */
export const BulkExportResponseSchema = z.union([BulkExportDoneSchema, HistoryCancelledSchema]);
export type BulkExportResponse = z.infer<typeof BulkExportResponseSchema>;

export const BulkProgressEventSchema = z.object({ done: z.number(), total: z.number() });
export type BulkProgressEvent = z.infer<typeof BulkProgressEventSchema>;
