import { z } from 'zod';
import { RectSchema } from './capture-schemas';
import { MAX_THUMBNAIL_BYTES } from './history-ipc';
import {
  MAX_EXPORT_BYTES,
  MAX_FRAME_DIMENSION,
  MAX_FRAME_PNG_BYTES,
  ShotKindSchema,
  ShotSessionMetaSchema,
} from './shots';

/** `screen:<n>:0` or `window:<hwnd>:<n>`, the only ids main will pass on. */
export const SourceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(screen|window):\d+:\d+$/);

const bytes = (max: number) =>
  z
    .instanceof(ArrayBuffer)
    .refine((buffer) => buffer.byteLength > 0, 'empty')
    .refine((buffer) => buffer.byteLength <= max, 'too large');

// --- main window -> main -------------------------------------------------------------------

export const StartScreenshotRequestSchema = z
  .object({
    target: ShotKindSchema,
    sourceId: SourceIdSchema.optional(),
  })
  .refine((request) => request.target !== 'window' || request.sourceId !== undefined, {
    message: 'A window capture needs a sourceId.',
    path: ['sourceId'],
  });
export type StartScreenshotRequest = z.infer<typeof StartScreenshotRequestSchema>;

export const ShotGetRequestSchema = z.object({ sessionId: z.string().min(1).max(64) });
export const ShotGetResponseSchema = z.object({
  session: ShotSessionMetaSchema,
  png: z.instanceof(ArrayBuffer),
});

export const ImageFormatSchema = z.enum(['png', 'jpeg']);

export const ShotExportRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  format: ImageFormatSchema,
  bytes: bytes(MAX_EXPORT_BYTES),
  /**
   * PNG thumbnail of the FLATTENED image (`flattenThumbnail`, at most 480 px wide) for history.
   * Main never makes a screenshot thumbnail itself: it only ever stores this one.
   */
  thumbnail: bytes(MAX_THUMBNAIL_BYTES).optional(),
});
export const ShotExportResponseSchema = z.union([
  z.object({ path: z.string() }),
  z.object({ cancelled: z.literal(true) }),
]);

export const ShotCopyRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  bytes: bytes(MAX_EXPORT_BYTES),
});

/** The editor reports whether closing the window would lose work (see main/close-guard.ts). */
export const EditorSetDirtyRequestSchema = z.object({ dirty: z.boolean() });

/** The user's answer to `app:confirmClose`: discard (close now) or keep editing. */
export const EditorResolveCloseRequestSchema = z.object({ discard: z.boolean() });

export const ShowItemInFolderRequestSchema = z.object({ path: z.string().min(1).max(1024) });

// --- overlay -> main -----------------------------------------------------------------------

/** region: frozen screenshot selection. pick-display: choose a screen. record-region: live selection for a recording. */
export const OverlayModeSchema = z.enum(['region', 'pick-display', 'record-region']);
export type OverlayMode = z.infer<typeof OverlayModeSchema>;

export const OverlayInitSchema = z.object({
  mode: OverlayModeSchema,
  displayId: z.string(),
  display: z.object({
    id: z.string(),
    bounds: RectSchema,
    scaleFactor: z.number(),
    rotation: z.number(),
  }),
  /** Pixel size of the captured frame (region) or the display's physical size (pick-display). */
  frameSize: z.object({ width: z.number(), height: z.number() }),
  /** The frozen frame (region mode only): raw 4-byte pixels (frameSize.width x frameSize.height). */
  image: z.instanceof(ArrayBuffer).nullable(),
  /** 'bgra': blue, green, red, alpha per pixel, rows top to bottom, as Electron's toBitmap(). */
  imageFormat: z.enum(['bgra']),
});
export type OverlayInit = z.infer<typeof OverlayInitSchema>;

export const OverlayConfirmRequestSchema = z.object({
  displayId: z.string().min(1).max(64),
  /** Selection in the overlay's local DIP, origin at the overlay's top-left. */
  rect: RectSchema,
});

export const OverlayPickDisplayRequestSchema = z.object({ displayId: z.string().min(1).max(64) });

// --- recorder worker -> main ---------------------------------------------------------------

export const WorkerFrameSchema = z.object({
  sourceId: SourceIdSchema,
  width: z.number().int().min(1).max(MAX_FRAME_DIMENSION),
  height: z.number().int().min(1).max(MAX_FRAME_DIMENSION),
  png: bytes(MAX_FRAME_PNG_BYTES),
});

export const WorkerFrameResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  frames: z.array(WorkerFrameSchema).min(1).max(8),
});

export const WorkerFrameErrorSchema = z.object({
  requestId: z.string().min(1).max(64),
  code: z.string().max(40),
  message: z.string().max(500),
});

// --- main -> renderer events ---------------------------------------------------------------

export const GrabFramesEventSchema = z.object({
  requestId: z.string(),
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        displayId: z.string().optional(),
        /** Only set by the mock provider in E2E builds: size of the synthetic frame to draw. */
        syntheticSize: z.object({ width: z.number(), height: z.number() }).optional(),
      }),
    )
    .max(8),
  synthetic: z.boolean().optional(),
});
export type GrabFramesEvent = z.infer<typeof GrabFramesEventSchema>;

export const FlowEndedEventSchema = z.object({
  outcome: z.enum(['cancelled', 'completed', 'error']),
  code: z.string().optional(),
  message: z.string().optional(),
});
export type FlowEndedEvent = z.infer<typeof FlowEndedEventSchema>;

export const ShotReadyEventSchema = z.object({ session: ShotSessionMetaSchema });
