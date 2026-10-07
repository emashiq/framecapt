import { z } from 'zod';
import { HistoryIdSchema } from './history-ipc';

/** The main window warns at this many tabs: each open item keeps its canvas or player alive. */
export const EDITOR_TAB_WARN = 12;

const SessionId = z.string().min(1).max(64);
const StepIndex = z.number().int().min(0).max(10_000);

/**
 * What a window asks for: open something as a tab of the main window. Main resolves the rest
 * (what a history item is, its file name), so no path ever comes from a renderer.
 */
export const EditorOpenRequestSchema = z.union([
  /** A screenshot session of this run: a picture that was opened, dropped or pasted. */
  z.strictObject({
    kind: z.literal('session'),
    sessionId: SessionId,
    imported: z.boolean().optional(),
  }),
  /**
   * A saved screenshot, recording or step guide of history. `viewer`: a screenshot or recording
   * opens in a viewer first (Edit turns the same tab into the editor); absent: straight to the editor.
   */
  z.strictObject({
    kind: z.literal('history'),
    historyId: HistoryIdSchema,
    viewer: z.boolean().optional(),
  }),
  /** One step of a saved step guide. */
  z.strictObject({ kind: z.literal('step'), historyId: HistoryIdSchema, index: StepIndex }),
]);
export type EditorOpenRequest = z.infer<typeof EditorOpenRequestSchema>;

/** Main -> the main window: open (or focus) this tab. */
export const EditorOpenTabEventSchema = z.union([
  z.strictObject({
    kind: z.literal('session'),
    sessionId: SessionId,
    imported: z.boolean().optional(),
    /** Set when "save after capture" already saved the capture: nothing is unsaved yet. */
    savedPath: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('shot'),
    historyId: HistoryIdSchema,
    title: z.string(),
    /** Show the picture first; Edit makes the same tab the editor. */
    viewer: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('video'),
    historyId: HistoryIdSchema,
    title: z.string(),
    viewer: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('flow'), historyId: HistoryIdSchema, title: z.string() }),
  z.strictObject({
    kind: z.literal('step'),
    historyId: HistoryIdSchema,
    index: StepIndex,
    title: z.string(),
  }),
]);
export type EditorOpenTabEvent = z.infer<typeof EditorOpenTabEventSchema>;

/** What the editor tabs hold, reported by the main window: closing must ask while `dirty`. */
export const EditorStateSchema = z.strictObject({ dirty: z.boolean() });
export type EditorState = z.infer<typeof EditorStateSchema>;

/** The user's answer to `editor:confirmClose`: discard (close now) or keep editing. */
export const EditorResolveCloseRequestSchema = z.strictObject({ discard: z.boolean() });

/** `editor:openVideo`: the Open dialog (main) for a video file; it opens in the video editor. */
export const OpenVideoResponseSchema = z.union([
  z.strictObject({ cancelled: z.literal(true) }),
  z.strictObject({ opened: z.literal(true) }),
]);

/** `history:splitSources`: every source of a multi-source recording as its own video. */
export const SplitSourcesRequestSchema = z.strictObject({ id: HistoryIdSchema });
export const SplitSourcesResponseSchema = z.strictObject({
  /** The history items of the sources, in the recording's order. */
  ids: z.array(HistoryIdSchema),
});
