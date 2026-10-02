import { z } from 'zod';

/** Pixel or DIP rectangle. */
export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const DisplayInfoSchema = z.object({
  /** String form of Electron's `display.id`; matches `display_id` of screen sources. */
  id: z.string(),
  label: z.string(),
  /** Bounds in DIP (display-independent pixels) in virtual-desktop coordinates; x/y may be negative. */
  bounds: RectSchema,
  scaleFactor: z.number(),
  rotation: z.number(),
  /** Native pixel size: round(bounds.size * scaleFactor). Electron reports bounds already rotated. */
  physicalSize: z.object({ width: z.number(), height: z.number() }),
  isPrimary: z.boolean(),
});
export type DisplayInfo = z.infer<typeof DisplayInfoSchema>;

export const SourceKindSchema = z.enum(['screen', 'window']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceInfoSchema = z.object({
  /** desktopCapturer id: `screen:<n>:0` or `window:<hwnd>:<n>`. */
  id: z.string(),
  name: z.string(),
  kind: SourceKindSchema,
  /** Only for screen sources that map to a display. */
  displayId: z.string().optional(),
  /** Small PNG data URL (<= THUMBNAIL_MAX_WIDTH wide). For the picker only, never for output. */
  thumbnail: z.string().optional(),
  appIcon: z.string().optional(),
});
export type SourceInfo = z.infer<typeof SourceInfoSchema>;

export const THUMBNAIL_MAX_WIDTH = 320;

export const ListSourcesRequestSchema = z.strictObject({
  types: z.array(SourceKindSchema).min(1).max(2),
  thumbnailWidth: z.number().int().min(0).max(THUMBNAIL_MAX_WIDTH).optional(),
});
export type ListSourcesRequest = z.infer<typeof ListSourcesRequestSchema>;

/** A capture grant is valid for a few seconds and is consumed by the first matching request. */
export const GRANT_TTL_MS = 5000;

export const CaptureGrantRequestSchema = z.strictObject({
  sourceId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^(screen|window):\d+:\d+$/),
  systemAudio: z.boolean(),
});
export type CaptureGrantRequest = z.infer<typeof CaptureGrantRequestSchema>;

export const CaptureGrantResponseSchema = z.object({
  grantId: z.string(),
  /** Epoch ms in main's clock. */
  expiresAt: z.number(),
});

/** Whole-blob saving is acceptable only for the bounded diagnostics prototype (10 s limit). */
export const DIAGNOSTICS_MAX_BYTES = 200 * 1024 * 1024;

export const SaveDiagnosticsRequestSchema = z.strictObject({
  ext: z.enum(['webm', 'mp4', 'mkv', 'png']),
  data: z
    .instanceof(ArrayBuffer)
    .refine((buffer) => buffer.byteLength > 0, 'empty')
    .refine((buffer) => buffer.byteLength <= DIAGNOSTICS_MAX_BYTES, 'too large'),
});

export const SaveDiagnosticsResponseSchema = z.object({
  /** Main-chosen file inside userData/diagnostics. */
  path: z.string(),
  bytes: z.number(),
});
