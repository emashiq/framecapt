import { z } from 'zod';
import { HistoryIdSchema } from './history-ipc';
import { MAX_ASSET_BYTES } from './project-ipc';
import {
  AUDIO_EXTENSIONS,
  AssetIdSchema,
  MAX_CLIP_MS,
  MAX_OVERLAYS,
  VideoExportFormatSchema,
  VideoProjectSchema,
} from './video-edit';

/** The video editor's channels. Everything goes by history id; main finds the file itself. */

export const VideoOpenRequestSchema = z.strictObject({ historyId: HistoryIdSchema });
export const VideoOpenResponseSchema = z.strictObject({
  project: VideoProjectSchema,
  /** The recording's file name, for the editor's title. */
  fileName: z.string(),
  /** False when the project is new (nothing was saved before, or the saved file was unusable). */
  restored: z.boolean(),
});

export const VideoSaveRequestSchema = z.strictObject({
  historyId: HistoryIdSchema,
  project: VideoProjectSchema,
});

const bytes = (max: number) =>
  z
    .instanceof(ArrayBuffer)
    .refine((buffer) => buffer.byteLength > 0, 'empty')
    .refine((buffer) => buffer.byteLength <= max, 'too large');

/** One text item drawn by the renderer: a transparent PNG as large as the item's box. */
export const MAX_OVERLAY_PNG_BYTES = 8 * 1024 * 1024;
export const MAX_OVERLAYS_TOTAL_BYTES = 64 * 1024 * 1024;
export const TextOverlaySchema = z.strictObject({
  itemId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  png: bytes(MAX_OVERLAY_PNG_BYTES),
});
export type TextOverlay = z.infer<typeof TextOverlaySchema>;

export const VideoExportRequestSchema = z.strictObject({
  historyId: HistoryIdSchema,
  project: VideoProjectSchema,
  format: VideoExportFormatSchema,
  /** The picture of every text item (main checks that each one matches its item). */
  overlays: z
    .array(TextOverlaySchema)
    .max(MAX_OVERLAYS)
    .refine(
      (list) =>
        list.reduce((sum, overlay) => sum + overlay.png.byteLength, 0) <= MAX_OVERLAYS_TOTAL_BYTES,
      'Too much overlay data.',
    )
    .default([]),
});

/** A picture for an image item: PNG bytes (the renderer converts JPEG and WebP first). */
export const VideoAddImageRequestSchema = z.strictObject({
  historyId: HistoryIdSchema,
  png: bytes(MAX_ASSET_BYTES),
});
export const VideoAddImageResponseSchema = z.strictObject({ assetId: AssetIdSchema });

/** Opens a file dialog in main for an audio file and adds it to the project's assets. */
export const VideoPickAudioRequestSchema = z.strictObject({ historyId: HistoryIdSchema });
export const VideoPickAudioResponseSchema = z.union([
  z.strictObject({ cancelled: z.literal(true) }),
  z.strictObject({
    assetId: AssetIdSchema,
    ext: z.enum(AUDIO_EXTENSIONS),
    name: z.string().max(120),
    durationMs: z.number().int().min(1).max(MAX_CLIP_MS),
  }),
]);
export const VideoExportResponseSchema = z.strictObject({ jobId: z.string().min(1).max(64) });

export const VideoExportProgressEventSchema = z.object({
  jobId: z.string(),
  historyId: HistoryIdSchema,
  /** 0..99 while encoding. */
  percent: z.number().nullable(),
});
export const VideoExportDoneEventSchema = z.object({
  jobId: z.string(),
  historyId: HistoryIdSchema,
  path: z.string(),
  format: VideoExportFormatSchema,
  /** The history item of the new file (null when it could not be added). */
  itemId: HistoryIdSchema.nullable(),
});
export const VideoExportFailedEventSchema = z.object({
  jobId: z.string(),
  historyId: HistoryIdSchema,
  code: z.string(),
  message: z.string(),
  cancelled: z.boolean(),
});
export type VideoExportProgressEvent = z.infer<typeof VideoExportProgressEventSchema>;
export type VideoExportDoneEvent = z.infer<typeof VideoExportDoneEventSchema>;
export type VideoExportFailedEvent = z.infer<typeof VideoExportFailedEventSchema>;
