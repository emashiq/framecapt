import { z } from 'zod';
import { RecordOptionsSchema } from '../../shared/recorder-ipc';

export const STREAM_FILE = 'stream.webm';
export const MANIFEST_FILE = 'manifest.json';
export const CORRUPT_MANIFEST_FILE = 'manifest.corrupt.json';
export const FINALIZE_LOG_FILE = 'finalize.log';
export const COMPLETED_DIR = 'completed';

export const SESSION_STATES = [
  'recording',
  'stopping',
  'stopped',
  'finalizing',
  'completed',
  'failed',
  'recovered',
  'discarded',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const PausedIntervalSchema = z.object({
  /** Epoch ms. */
  from: z.number(),
  to: z.number().nullable(),
});
export type PausedInterval = z.infer<typeof PausedIntervalSchema>;

/** Backpressure numbers for the phase 09 benchmarks (see docs/recording-persistence.md). */
export const SessionStatsSchema = z.object({
  /** Most chunks the renderer had queued when it sent one. */
  queueHighWaterChunks: z.number().default(0),
  queueHighWaterBytes: z.number().default(0),
  /** Most operations waiting in main for one session. */
  mainQueueHighWater: z.number().default(0),
  /** Slowest single chunk write, ms. */
  maxWriteMs: z.number().default(0),
});
export type SessionStats = z.infer<typeof SessionStatsSchema>;

export const FinalizePlanSchema = z.object({
  outputDir: z.string(),
  fileName: z.string(),
  partialPath: z.string(),
  startedAt: z.number(),
});
export type FinalizePlan = z.infer<typeof FinalizePlanSchema>;

/** `manifest.json`: everything needed to understand (and later recover) a session directory. */
export const SessionManifestSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  state: z.enum(SESSION_STATES),
  mime: z.string(),
  source: z.object({
    kind: z.enum(['screen', 'window', 'region']),
    displayId: z.string().optional(),
    name: z.string(),
  }),
  options: RecordOptionsSchema,
  width: z.number(),
  height: z.number(),
  chunksWritten: z.number(),
  bytesWritten: z.number(),
  lastSeq: z.number(),
  pausedIntervals: z.array(PausedIntervalSchema),
  stats: SessionStatsSchema.default({
    queueHighWaterChunks: 0,
    queueHighWaterBytes: 0,
    mainQueueHighWater: 0,
    maxWriteMs: 0,
  }),
  appVersion: z.string(),
  /** Set when the file may be shorter than the recording (write failure, engine lost). */
  truncated: z.literal(true).optional(),
  /** Why the session ended early, when it did. */
  endReason: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  finalize: FinalizePlanSchema.optional(),
  outputPath: z.string().optional(),
  /** The output is a raw copy of the stream (remux failed): it has no duration or seek index. */
  unindexed: z.literal(true).optional(),
});
export type SessionManifest = z.infer<typeof SessionManifestSchema>;

/** `completed/<sessionId>.json`: what history needs after the session directory is gone. */
export const CompletionRecordSchema = z.object({
  sessionId: z.string(),
  completedAt: z.number(),
  createdAt: z.number(),
  outputPath: z.string(),
  durationMs: z.number().nullable(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  source: z.object({ kind: z.enum(['screen', 'window', 'region']) }),
  hasAudio: z.boolean(),
  mime: z.string(),
  recovered: z.boolean(),
  unindexed: z.boolean(),
  pausedIntervals: z.array(PausedIntervalSchema),
  /** Backpressure numbers of the session (phase 09 benchmarks read them from here). */
  stats: SessionStatsSchema,
});
export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function parseManifest(
  text: string,
): { ok: true; manifest: SessionManifest } | { ok: false } {
  try {
    const parsed = SessionManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function freshStats(): SessionStats {
  return { queueHighWaterChunks: 0, queueHighWaterBytes: 0, mainQueueHighWater: 0, maxWriteMs: 0 };
}

/** The name of the temporary remux output: it carries the session id so its owner is provable. */
export function partialFileName(sessionId: string): string {
  return `.framecapt-${sessionId}.partial.webm`;
}
