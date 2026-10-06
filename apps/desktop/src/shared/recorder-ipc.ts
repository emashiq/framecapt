import { z } from 'zod';
import { CameraCornerSchema, CameraShapeSchema, CameraSizeSchema } from './camera';
import { RectSchema } from './capture-schemas';
import { FOLLOW_ZOOMS } from './compositor-layout';
import { HistoryIdSchema } from './history-ipc';
import { FPS_VALUES, QUALITY_VALUES } from './recording';
import { RECORDER_STATUSES } from './recorder-machine';
import { MAX_MULTI_SOURCES } from './recording-layout';
import { SourceIdSchema } from './shot-ipc';

// --- options and requests (main window -> main) ----------------------------------------------

export const RecordTargetSchema = z.enum(['screen', 'window', 'region', 'multi']);
export type RecordTarget = z.infer<typeof RecordTargetSchema>;

const FOLLOW_ZOOM_LITERALS = [
  z.literal(FOLLOW_ZOOMS[0]),
  z.literal(FOLLOW_ZOOMS[1]),
  z.literal(FOLLOW_ZOOMS[2]),
] as const;

export const RecordOptionsSchema = z.strictObject({
  mic: z.strictObject({
    enabled: z.boolean(),
    /** Undefined = the default microphone. */
    deviceId: z.string().max(256).optional(),
  }),
  systemAudio: z.boolean(),
  quality: z.enum(QUALITY_VALUES),
  fps: z.union([z.literal(FPS_VALUES[0]), z.literal(FPS_VALUES[1])]),
  /** A 3-2-1 countdown before recording starts. */
  countdown: z.boolean(),
  /**
   * Screen recordings only: the picture is a zoomed window that follows the mouse. Optional so
   * manifests written before it existed still parse.
   */
  follow: z.strictObject({ zoom: z.union(FOLLOW_ZOOM_LITERALS) }).optional(),
  /** Compressed storage: record at a lower bitrate. Optional, so older manifests still parse. */
  compressed: z.boolean().optional(),
  /**
   * The webcam overlay: composited into the picture. `corner` places it for window recordings.
   * Optional, so manifests written before it existed still parse.
   */
  camera: z
    .strictObject({
      /** Undefined = the default camera. */
      deviceId: z.string().max(256).optional(),
      shape: CameraShapeSchema,
      size: CameraSizeSchema,
      corner: CameraCornerSchema,
    })
    .optional(),
});
export type RecordOptions = z.infer<typeof RecordOptionsSchema>;

export const DEFAULT_RECORD_OPTIONS: RecordOptions = {
  mic: { enabled: false },
  systemAudio: false,
  quality: '1080p',
  fps: 30,
  countdown: true,
};

export const RecorderStartRequestSchema = z
  .strictObject({
    target: RecordTargetSchema,
    /** Window recordings: the window to record. */
    sourceId: SourceIdSchema.optional(),
    /** Multi-source recordings: 2 to 4 screens and/or windows; the first is the primary. */
    sources: z
      .array(z.strictObject({ sourceId: SourceIdSchema }))
      .min(2)
      .max(MAX_MULTI_SOURCES)
      .optional(),
    /** Screen recordings: skip the "pick a screen" step. */
    displayId: z.string().min(1).max(64).optional(),
    options: RecordOptionsSchema,
  })
  .refine((request) => request.target !== 'window' || request.sourceId !== undefined, {
    message: 'A window recording needs a sourceId.',
    path: ['sourceId'],
  })
  .refine((request) => (request.target === 'multi') === (request.sources !== undefined), {
    message: 'Only a multi-source recording takes sources (and it needs them).',
    path: ['sources'],
  })
  .refine(
    (request) =>
      new Set(request.sources?.map((source) => source.sourceId)).size ===
      (request.sources?.length ?? 0),
    { message: 'Each source can be recorded once.', path: ['sources'] },
  );
export type RecorderStartRequest = z.infer<typeof RecorderStartRequestSchema>;

export const AudioSourceSchema = z.enum(['mic', 'system']);
export const ToggleMuteRequestSchema = z.strictObject({ source: AudioSourceSchema });

export const PreflightChoiceKindSchema = z.enum([
  'system-audio-unavailable',
  'mic-missing',
  'mic-denied',
  'mic-unavailable',
  'camera-missing',
]);
export const ChoiceAnswerSchema = z.enum(['continue-without', 'use-default', 'cancel']);
export const ResolveChoiceRequestSchema = z.strictObject({ answer: ChoiceAnswerSchema });

export const RecordingIdRequestSchema = z.strictObject({ resultId: z.string().min(1).max(64) });

// --- state broadcast (main -> every app window) ----------------------------------------------

const AudioFlagsSchema = z.strictObject({ mic: z.boolean(), system: z.boolean() });

export const RecordingResultSchema = z.object({
  /** Main-owned id: the media URL is `framecapt-media://<id>`. */
  id: z.string(),
  /** The history entry of the file (`export:mp4` takes it); null when it could not be added. */
  historyId: HistoryIdSchema.nullable(),
  fileName: z.string(),
  path: z.string(),
  durationMs: z.number(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  mime: z.string(),
  createdAt: z.number(),
  hasAudio: z.boolean(),
  /** The remux failed and the file is a raw copy: it plays but has no duration or seek index. */
  unindexed: z.boolean(),
});
export type RecordingResult = z.infer<typeof RecordingResultSchema>;

export const RecorderSnapshotSchema = z.object({
  status: z.enum(RECORDER_STATUSES),
  sessionId: z.string().nullable(),
  target: RecordTargetSchema.nullable(),
  startedAt: z.number().nullable(),
  /** Active recording time up to the moment of the snapshot (paused time excluded), ms. */
  activeMs: z.number(),
  /** Epoch ms at which the running segment began: timer = activeMs + (Date.now() - runningSince). */
  runningSince: z.number().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  stopReason: z
    .enum(['user', 'source-lost', 'write-failed', 'engine-closed', 'app-quit'])
    .nullable(),
  audio: AudioFlagsSchema,
  muted: AudioFlagsSchema,
  lost: AudioFlagsSchema,
  /** Multi-source recordings: indexes of the sources that went away (the recording goes on). */
  lostTiles: z.array(
    z
      .number()
      .int()
      .min(0)
      .max(MAX_MULTI_SOURCES - 1),
  ),
  choice: PreflightChoiceKindSchema.nullable(),
  /** The "Use default microphone" answer is only offered when a default microphone exists. */
  choiceCanUseDefault: z.boolean(),
  /** The recording has a camera overlay (null: none) and whether it is shown right now. */
  camera: z.strictObject({ visible: z.boolean() }).nullable(),
  /** The app is quitting and finishing the recording first. */
  quitting: z.boolean(),
  /** The number on the countdown right now (3, 2, 1), else null. */
  countdown: z.number().nullable(),
  /** How far finishing the file has come (0..1), while it is being saved; null when unknown. */
  progress: z.number().min(0).max(1).nullable(),
  /** Output size of the video once it is known (from preflight). */
  width: z.number().nullable(),
  height: z.number().nullable(),
  result: RecordingResultSchema.nullable(),
});
export type RecorderSnapshot = z.infer<typeof RecorderSnapshotSchema>;

export const LevelsEventSchema = z.object({ mic: z.number(), system: z.number() });

// --- main <-> the hidden recorder window -----------------------------------------------------

const RequestIdSchema = z.string().min(1).max(64);

/** One source of a multi-source recording, as main hands it to the engine. */
export const EngineMultiSourceSchema = z.strictObject({
  sourceId: SourceIdSchema,
  kind: z.enum(['screen', 'window']),
  /** Screens: where the display sits on the virtual desktop, in physical pixels (null: a window). */
  rect: RectSchema.strict().nullable(),
  /** E2E builds only: draw a synthetic picture of this size instead of capturing. */
  synthetic: z.object({ width: z.number(), height: z.number() }).optional(),
});
export type EngineMultiSource = z.infer<typeof EngineMultiSourceSchema>;

export const EnginePrepareSchema = z.object({
  cmd: z.literal('prepare'),
  requestId: RequestIdSchema,
  sourceId: SourceIdSchema,
  kind: z.enum(['screen', 'window']),
  /** Region in PIXELS of the display, already clamped and even-aligned by main. */
  region: RectSchema.strict().nullable(),
  /** Physical size of the display (screen and region); used for sizing and validation. */
  displaySize: z.object({ width: z.number(), height: z.number() }).nullable(),
  options: RecordOptionsSchema,
  /** Multi-source recordings: every source, in order (the first is the primary and gets the system audio). */
  multi: z.array(EngineMultiSourceSchema).min(2).max(MAX_MULTI_SOURCES).optional(),
  /** E2E builds only: draw a synthetic picture of this size instead of capturing. */
  synthetic: z.object({ width: z.number(), height: z.number() }).optional(),
});

export const EngineCommandSchema = z.discriminatedUnion('cmd', [
  EnginePrepareSchema,
  z.object({ cmd: z.literal('start'), requestId: RequestIdSchema, sessionId: z.string() }),
  z.object({ cmd: z.literal('pause') }),
  z.object({ cmd: z.literal('resume') }),
  z.object({ cmd: z.literal('stop'), requestId: RequestIdSchema }),
  /** Release everything (streams, audio, timers) without finishing a session. */
  z.object({ cmd: z.literal('abort') }),
  z.object({ cmd: z.literal('mute'), source: AudioSourceSchema, muted: z.boolean() }),
  z.object({ cmd: z.literal('levels'), enabled: z.boolean() }),
  /** Follow-mouse recordings: the mouse, 0..1 across the recorded display (main sends ~30 per second). */
  z.object({
    cmd: z.literal('cursor'),
    nx: z.number().min(0).max(1),
    ny: z.number().min(0).max(1),
  }),
  /** The webcam overlay: where its center is (0..1 across the output), how big, its shape, shown or not. */
  z.object({
    cmd: z.literal('camera'),
    nx: z.number().min(0).max(1),
    ny: z.number().min(0).max(1),
    size: CameraSizeSchema,
    shape: CameraShapeSchema,
    visible: z.boolean(),
  }),
]);
export type EngineCommand = z.infer<typeof EngineCommandSchema>;
export type EnginePrepareCommand = z.infer<typeof EnginePrepareSchema>;

export const EngineEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('prepared'),
    requestId: z.string(),
    mime: z.string().max(200),
    width: z.number().int(),
    height: z.number().int(),
    audio: AudioFlagsSchema,
    /** Multi-source recordings: each source's tile in the picture, in order. */
    tiles: z.array(RectSchema.strict()).max(MAX_MULTI_SOURCES).optional(),
  }),
  z.strictObject({
    type: z.literal('needsChoice'),
    requestId: z.string(),
    choice: PreflightChoiceKindSchema,
    canUseDefaultMic: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('prepareFailed'),
    requestId: z.string(),
    code: z.string().max(60),
    message: z.string().max(500),
  }),
  z.strictObject({ type: z.literal('started'), requestId: z.string() }),
  z.strictObject({ type: z.literal('paused') }),
  z.strictObject({ type: z.literal('resumed') }),
  z.strictObject({
    type: z.literal('stopped'),
    requestId: z.string(),
    lastSeq: z.number().int().min(-1),
    chunks: z.number().int().min(0),
    bytes: z.number().min(0),
  }),
  z.strictObject({ type: z.literal('sourceLost') }),
  /** Multi-source recordings: one source ended; its tile is blank and the recording continues. */
  z.strictObject({
    type: z.literal('tileLost'),
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_MULTI_SOURCES - 1),
  }),
  z.strictObject({ type: z.literal('trackEnded'), source: AudioSourceSchema }),
  z.strictObject({ type: z.literal('levels'), mic: z.number(), system: z.number() }),
  z.strictObject({
    type: z.literal('error'),
    code: z.string().max(60),
    message: z.string().max(500),
    requestId: z.string().optional(),
  }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;

// --- recording sessions (recorder window -> main) --------------------------------------------

/** Largest chunk main accepts. A one second chunk is about 1-3 MB at the highest quality. */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** The uploader's bounds: more pending than this stops the recording (never dropped, never unbounded). */
export const MAX_PENDING_CHUNKS = 16;
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const CHUNK_TIMESLICE_MS = 1000;

const SessionIdSchema = z.string().min(1).max(64);

export const AppendChunkRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  seq: z.number().int().min(0).max(1_000_000_000),
  /** The renderer's own queue when this chunk was sent (backpressure statistics only). */
  queued: z
    .strictObject({
      chunks: z.number().int().min(0).max(1_000_000),
      bytes: z.number().min(0),
    })
    .optional(),
  bytes: z
    .instanceof(ArrayBuffer)
    .refine((buffer) => buffer.byteLength > 0, 'empty')
    .refine((buffer) => buffer.byteLength <= MAX_CHUNK_BYTES, 'too large'),
});
export const AppendChunkResponseSchema = z.strictObject({
  /** True when this exact chunk had already been written (an idempotent retry). */
  duplicate: z.boolean(),
  lastSeq: z.number().int(),
});

export const FinishSessionRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  lastSeq: z.number().int().min(-1),
});
export const FinishSessionResponseSchema = z.strictObject({
  chunks: z.number().int(),
  bytes: z.number(),
});
