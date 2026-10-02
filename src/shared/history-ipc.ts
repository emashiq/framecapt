import { z } from 'zod';

/** History ids are random uuids made by main; the renderer only ever sends them back. */
export const HISTORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HistoryIdSchema = z.string().regex(HISTORY_ID_PATTERN);

export const HistoryTypeSchema = z.enum(['screenshot', 'recording']);
export type HistoryType = z.infer<typeof HistoryTypeSchema>;

export const HistorySourceSchema = z.enum(['screen', 'window', 'region', 'unknown']);
export type HistorySource = z.infer<typeof HistorySourceSchema>;

export const HISTORY_FORMATS = ['png', 'jpeg', 'webm', 'mp4'] as const;
export const HistoryFormatSchema = z.enum(HISTORY_FORMATS);
export type HistoryFormat = z.infer<typeof HistoryFormatSchema>;

/** Largest thumbnail main accepts from the editor, and the widest it may be. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const MAX_THUMBNAIL_WIDTH = 480;
/** Largest image `history:copyImage` reads into the clipboard. */
export const MAX_COPY_IMAGE_BYTES = 200 * 1024 * 1024;

/** One entry as the renderer sees it: facts about a file Framelet produced, plus whether it still exists. */
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
  /** False when the file was moved or deleted outside Framelet. */
  exists: z.boolean(),
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
  reason: z.string().optional(),
});
export type ExportCapabilities = z.infer<typeof ExportCapabilitiesSchema>;

export const ExportMp4RequestSchema = z.strictObject({ historyId: HistoryIdSchema });
export const ExportMp4ResponseSchema = z.union([
  z.strictObject({ jobId: z.string() }),
  HistoryCancelledSchema,
]);
export const ExportCancelRequestSchema = z.strictObject({ jobId: z.string().min(1).max(64) });

export const ExportProgressEventSchema = z.object({
  jobId: z.string(),
  historyId: HistoryIdSchema,
  /** 0..99 while encoding; null when the length of the recording is not known. */
  percent: z.number().nullable(),
});
export const ExportDoneEventSchema = z.object({
  jobId: z.string(),
  historyId: HistoryIdSchema,
  path: z.string(),
  /** The history item of the new MP4 (null when it could not be added). */
  itemId: HistoryIdSchema.nullable(),
});
export const ExportFailedEventSchema = z.object({
  jobId: z.string(),
  historyId: HistoryIdSchema,
  code: z.string(),
  message: z.string(),
  cancelled: z.boolean(),
});
export type ExportProgressEvent = z.infer<typeof ExportProgressEventSchema>;
export type ExportDoneEvent = z.infer<typeof ExportDoneEventSchema>;
export type ExportFailedEvent = z.infer<typeof ExportFailedEventSchema>;
