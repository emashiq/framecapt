import { z } from 'zod';

/** Session ids are random uuids made by main; anything else is rejected before it is looked at. */
export const RecoverySessionIdSchema = z.strictObject({
  sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
});

export const RecoveryCandidateSchema = z.object({
  sessionId: z.string(),
  /** Epoch ms of the start of the recording (the directory time when the manifest was unreadable). */
  createdAt: z.number(),
  /** Size of the unfinished stream on disk. */
  bytes: z.number(),
  sourceKind: z.enum(['screen', 'window', 'region', 'multi', 'unknown']),
  chunks: z.number(),
  /** The state the session was left in; `unknown` when its manifest could not be read. */
  state: z.enum(['recording', 'stopping', 'stopped', 'finalizing', 'failed', 'unknown']),
  /** Why it ended early, when the manifest says so (e.g. DISK_FULL). */
  errorCode: z.string().nullable(),
});
export type RecoveryCandidate = z.infer<typeof RecoveryCandidateSchema>;

export const RecoveryListResponseSchema = z.object({
  candidates: z.array(RecoveryCandidateSchema),
});

export const RecoverResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('recovered'),
    /** Main-owned id of the recovered file (`recorder:showInFolder` takes it). */
    resultId: z.string(),
    fileName: z.string(),
    path: z.string(),
    durationMs: z.number(),
    bytes: z.number(),
  }),
  z.object({
    outcome: z.literal('unrecoverable'),
    /** Where the raw data was kept, for diagnostics. */
    keptAt: z.string(),
  }),
]);
export type RecoverResponse = z.infer<typeof RecoverResponseSchema>;
