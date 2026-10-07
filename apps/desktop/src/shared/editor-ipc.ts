import { z } from 'zod';
import { HistoryIdSchema } from './history-ipc';

/** The Editor window warns at this many tabs: each open item keeps its canvas or player alive. */
export const EDITOR_TAB_WARN = 12;
const MAX_TABS = 64;

const SessionId = z.string().min(1).max(64);
const StepIndex = z.number().int().min(0).max(10_000);

/**
 * What a window asks for: open something as a tab of the Editor window. Main resolves the rest
 * (what a history item is, its file name), so no path ever comes from a renderer.
 */
export const EditorOpenRequestSchema = z.union([
  /** A screenshot session of this run: a picture that was opened, dropped or pasted. */
  z.strictObject({
    kind: z.literal('session'),
    sessionId: SessionId,
    imported: z.boolean().optional(),
  }),
  /** A saved screenshot or recording of history. */
  z.strictObject({ kind: z.literal('history'), historyId: HistoryIdSchema }),
  /** One step of a saved step guide. */
  z.strictObject({ kind: z.literal('step'), historyId: HistoryIdSchema, index: StepIndex }),
]);
export type EditorOpenRequest = z.infer<typeof EditorOpenRequestSchema>;

/** Main -> the Editor window: open (or focus) this tab. */
export const EditorOpenTabEventSchema = z.union([
  z.strictObject({
    kind: z.literal('session'),
    sessionId: SessionId,
    imported: z.boolean().optional(),
    /** Set when "save after capture" already saved the capture: nothing is unsaved yet. */
    savedPath: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('shot'), historyId: HistoryIdSchema, title: z.string() }),
  z.strictObject({ kind: z.literal('video'), historyId: HistoryIdSchema, title: z.string() }),
  z.strictObject({
    kind: z.literal('step'),
    historyId: HistoryIdSchema,
    index: StepIndex,
    title: z.string(),
  }),
]);
export type EditorOpenTabEvent = z.infer<typeof EditorOpenTabEventSchema>;

/** What the Editor window holds, reported by it: closing must ask while `dirty`. */
export const EditorStateSchema = z.strictObject({
  tabs: z.number().int().min(0).max(MAX_TABS),
  dirty: z.boolean(),
});
export type EditorState = z.infer<typeof EditorStateSchema>;

/** The user's answer to `editor:confirmClose`: discard (close now) or keep editing. */
export const EditorResolveCloseRequestSchema = z.strictObject({ discard: z.boolean() });
