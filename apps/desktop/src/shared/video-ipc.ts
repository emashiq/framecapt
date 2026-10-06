import { z } from 'zod';
import { HistoryIdSchema } from './history-ipc';
import { VideoExportFormatSchema, VideoProjectSchema } from './video-edit';

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

export const VideoExportRequestSchema = z.strictObject({
  historyId: HistoryIdSchema,
  project: VideoProjectSchema,
  format: VideoExportFormatSchema,
});
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
