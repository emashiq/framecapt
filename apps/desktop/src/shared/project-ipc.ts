import { z } from 'zod';
import { MAX_THUMBNAIL_BYTES } from './history-ipc';
import { MAX_EXPORT_BYTES, ShotSessionMetaSchema } from './shots';

const ImageFormatSchema = z.enum(['png', 'jpeg']);
const bytes = (max: number) =>
  z
    .instanceof(ArrayBuffer)
    .refine((buffer) => buffer.byteLength > 0, 'empty')
    .refine((buffer) => buffer.byteLength <= max, 'too large');

/** Version of `project.json` (the container). The editor document inside carries its own `schema`. */
export const PROJECT_VERSION = 1;
/** Version of the editor tool set that wrote a project (recorded in project.json for diagnostics). */
export const EDITOR_TOOL_VERSION = 2;
/** Largest editor document main stores for one project (serialized JSON). */
export const MAX_PROJECT_DOC_BYTES = 8 * 1024 * 1024;

/**
 * The editor document of a project. It belongs to the renderer (src/renderer/editor/model migrates
 * and validates it); main only checks that it is a plain JSON object of bounded size and stores it.
 */
export const ProjectDocSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (doc) => JSON.stringify(doc).length <= MAX_PROJECT_DOC_BYTES,
    'The project is too large.',
  );
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;

/** Sent with an export: the editable state to keep next to the flattened image. */
export const ShotProjectPayloadSchema = z.strictObject({ doc: ProjectDocSchema });

/** Overwrites the history item the session was opened from (no dialog). */
export const ShotSaveOverRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(64),
  format: ImageFormatSchema,
  bytes: bytes(MAX_EXPORT_BYTES),
  thumbnail: bytes(MAX_THUMBNAIL_BYTES).optional(),
  project: ShotProjectPayloadSchema.optional(),
});
export const ShotSaveOverResponseSchema = z.strictObject({
  historyId: z.string(),
  path: z.string(),
  /** An editable project is stored with the item now. */
  editable: z.boolean(),
});

export const OpenFromHistoryRequestSchema = z.strictObject({
  historyId: z.string().regex(/^[0-9a-f-]{36}$/),
  /** Open the saved image even when an editable project exists (the editor could not read it). */
  flattened: z.boolean().optional(),
});

/** `project`: original and annotations restored. `flattened`: the history file is the base image. */
export const EditModeSchema = z.enum(['project', 'flattened']);
export const OpenFromHistoryResponseSchema = z.strictObject({
  session: ShotSessionMetaSchema,
  /** The base image as PNG (the project's original, or the history file converted to PNG). */
  png: z.instanceof(ArrayBuffer),
  edit: z.strictObject({
    historyId: z.string(),
    /** The format of the history file: Save keeps it. */
    format: ImageFormatSchema,
    mode: EditModeSchema,
    /** The stored editor document (project mode only; the renderer validates and migrates it). */
    doc: ProjectDocSchema.nullable(),
    /** Why the project could not be used (corrupt, newer version...), or null. */
    notice: z.string().max(300).nullable(),
  }),
});
export type OpenFromHistoryResponse = z.infer<typeof OpenFromHistoryResponseSchema>;
