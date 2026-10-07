import { z } from 'zod';
import { FlowFileSchema, MAX_CAPTION_LENGTH, MAX_FLOW_STEPS, MAX_TITLE_LENGTH } from './flow';
import { HistoryIdSchema } from './history-ipc';

// --- capturing steps (the pill, the shortcuts, Home) ------------------------------

export const STEPS_STATES = ['idle', 'active', 'paused', 'saving'] as const;

/** What the Steps pill and the main window render; main owns the real state. */
export const StepsSnapshotSchema = z.object({
  state: z.enum(STEPS_STATES),
  /** Steps are taken on their own when the pointer rests. */
  auto: z.boolean(),
  count: z.number().int().min(0),
  max: z.number().int(),
  /** One sentence to show for a moment (the step limit, a failed save); null otherwise. */
  notice: z.string().max(300).nullable(),
});
export type StepsSnapshot = z.infer<typeof StepsSnapshotSchema>;

export const StepsSetAutoRequestSchema = z.strictObject({ auto: z.boolean() });

/** Done: the guide was saved (`historyId`), or there was nothing to save. */
export const StepsDoneResponseSchema = z.union([
  z.strictObject({ historyId: HistoryIdSchema }),
  z.strictObject({ discarded: z.literal(true) }),
]);

/** Sent to the main window when a guide was saved: it opens the Flow view. */
export const StepsFinishedEventSchema = z.object({ historyId: HistoryIdSchema });

// --- the Flow view -----------------------------------------------------------------------------

export const FlowGetRequestSchema = z.strictObject({ historyId: HistoryIdSchema });
export const FlowGetResponseSchema = z.object({
  flow: FlowFileSchema,
  /** One `framecapt-media://flowstep/...` URL per step, in order. */
  stepUrls: z.array(z.string()),
});
export type FlowGetResponse = z.infer<typeof FlowGetResponseSchema>;

/**
 * Edits of the Flow view: the title and the complete ordered list of steps by file name (a step
 * left out is deleted, a step that was just deleted may be put back). Main checks every name
 * against the files of the guide's own folder.
 */
export const FlowUpdateRequestSchema = z.strictObject({
  historyId: HistoryIdSchema,
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
  steps: z
    .array(
      z.strictObject({
        file: z.string().max(32),
        caption: z.string().max(MAX_CAPTION_LENGTH),
      }),
    )
    .min(1)
    .max(MAX_FLOW_STEPS)
    .optional(),
});

export const FlowOpenStepRequestSchema = z.strictObject({
  historyId: HistoryIdSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_FLOW_STEPS - 1),
});

/** The picture of one step as PNG bytes (for the exports: the media route cannot be read into a canvas). */
export const FlowReadStepResponseSchema = z.strictObject({ png: z.instanceof(ArrayBuffer) });

export const FLOW_EXPORT_KINDS = ['images', 'html', 'mp4', 'gif'] as const;
/** Largest picture and largest total the renderer may send for one export. */
export const MAX_FLOW_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_FLOW_EXPORT_BYTES = 512 * 1024 * 1024;

/**
 * Export of a guide. The renderer draws the pictures (the pointer ring, and for images and videos
 * the caption banner) and sends them as PNG bytes, one per step in order; main checks them, takes
 * titles and captions from the guide's own file and asks where to save in a main dialog.
 */
export const FlowExportRequestSchema = z.strictObject({
  historyId: HistoryIdSchema,
  kind: z.enum(FLOW_EXPORT_KINDS),
  frames: z
    .array(
      z
        .instanceof(ArrayBuffer)
        .refine((buffer) => buffer.byteLength > 0, 'empty')
        .refine((buffer) => buffer.byteLength <= MAX_FLOW_FRAME_BYTES, 'too large'),
    )
    .min(1)
    .max(MAX_FLOW_STEPS)
    .refine(
      (frames) => frames.reduce((sum, frame) => sum + frame.byteLength, 0) <= MAX_FLOW_EXPORT_BYTES,
      'The export is too large.',
    ),
});
export const FlowExportResponseSchema = z.union([
  z.strictObject({ cancelled: z.literal(true) }),
  /** Images and HTML are written at once: the path to show in the folder. */
  z.strictObject({ path: z.string() }),
  /** A video is encoded as a job; `export:progress|done|failed` follow. */
  z.strictObject({ jobId: z.string() }),
]);
export type FlowExportResponse = z.infer<typeof FlowExportResponseSchema>;
