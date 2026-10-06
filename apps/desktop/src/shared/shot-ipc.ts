import { z } from 'zod';
import { RectSchema } from './capture-schemas';
import { MAX_THUMBNAIL_BYTES } from './history-ipc';
import { ShotProjectPayloadSchema } from './project-ipc';
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
  .strictObject({
    target: ShotKindSchema,
    sourceId: SourceIdSchema.optional(),
    /** One image of every screen, joined (target must be 'screen'). */
    allScreens: z.boolean().optional(),
  })
  .refine((request) => !request.allScreens || request.target === 'screen', {
    message: 'All screens is a screen capture.',
    path: ['allScreens'],
  })
  .refine((request) => request.target !== 'window' || request.sourceId !== undefined, {
    message: 'A window capture needs a sourceId.',
    path: ['sourceId'],
  });
export type StartScreenshotRequest = z.infer<typeof StartScreenshotRequestSchema>;

export const ShotGetRequestSchema = z.strictObject({ sessionId: z.string().min(1).max(64) });
export const ShotGetResponseSchema = z.strictObject({
  session: ShotSessionMetaSchema,
  png: z.instanceof(ArrayBuffer),
});

export const ImageFormatSchema = z.enum(['png', 'jpeg']);

export const ShotExportRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(64),
  format: ImageFormatSchema,
  bytes: bytes(MAX_EXPORT_BYTES),
  /**
   * PNG thumbnail of the FLATTENED image (`flattenThumbnail`, at most 480 px wide) for history.
   * Main never makes a screenshot thumbnail itself: it only ever stores this one.
   */
  thumbnail: bytes(MAX_THUMBNAIL_BYTES).optional(),
  /** The editable state to keep next to the image (ignored when Settings turn editable originals off). */
  project: ShotProjectPayloadSchema.optional(),
});
export const ShotExportResponseSchema = z.union([
  z.strictObject({ path: z.string(), historyId: z.string().optional() }),
  z.strictObject({ cancelled: z.literal(true) }),
]);

/** Quick save: the same payload as an export, written to the screenshots folder with no dialog. */
export const ShotQuickSaveResponseSchema = z.strictObject({
  path: z.string(),
  historyId: z.string().optional(),
});

export const ShotCopyRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(64),
  bytes: bytes(MAX_EXPORT_BYTES),
});

/** The editor reports whether closing the window would lose work (see main/close-guard.ts). */
export const EditorSetDirtyRequestSchema = z.strictObject({
  dirty: z.boolean(),
  /** A screenshot is open in the editor (saved or not). */
  open: z.boolean().optional(),
});

/** The user's answer to `app:confirmClose`: discard (close now) or keep editing. */
export const EditorResolveCloseRequestSchema = z.strictObject({ discard: z.boolean() });

export const ShowItemInFolderRequestSchema = z.strictObject({ path: z.string().min(1).max(1024) });

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

export const OverlayConfirmRequestSchema = z.strictObject({
  displayId: z.string().min(1).max(64),
  /** Selection in the overlay's local DIP, origin at the overlay's top-left. */
  rect: RectSchema.strict(),
});

export const OverlayPickDisplayRequestSchema = z.strictObject({
  displayId: z.string().min(1).max(64),
});

// --- recorder worker -> main ---------------------------------------------------------------

export const WorkerFrameSchema = z.strictObject({
  sourceId: SourceIdSchema,
  width: z.number().int().min(1).max(MAX_FRAME_DIMENSION),
  height: z.number().int().min(1).max(MAX_FRAME_DIMENSION),
  png: bytes(MAX_FRAME_PNG_BYTES),
});

/** All frames of one answer together: eight screens at the per-frame cap would be over a gigabyte. */
export const MAX_WORKER_FRAMES_TOTAL_BYTES = 512 * 1024 * 1024;

export const WorkerFrameResultSchema = z
  .strictObject({
    requestId: z.string().min(1).max(64),
    frames: z.array(WorkerFrameSchema).min(1).max(8),
  })
  .refine(
    (result) =>
      result.frames.reduce((sum, frame) => sum + frame.png.byteLength, 0) <=
      MAX_WORKER_FRAMES_TOTAL_BYTES,
    {
      message: 'Too much frame data in one answer.',
      path: ['frames'],
    },
  );

export const WorkerFrameErrorSchema = z.strictObject({
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

export const ShotReadyEventSchema = z.object({
  session: ShotSessionMetaSchema,
  /** Set when the "save and open the editor" setting already saved the capture: nothing is unsaved yet. */
  savedPath: z.string().optional(),
});
