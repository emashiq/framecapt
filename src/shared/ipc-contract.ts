import { z } from 'zod';
import {
  CaptureGrantRequestSchema,
  CaptureGrantResponseSchema,
  DisplayInfoSchema,
  ListSourcesRequestSchema,
  SaveDiagnosticsRequestSchema,
  SaveDiagnosticsResponseSchema,
  SourceInfoSchema,
} from './capture-schemas';
import {
  EditorResolveCloseRequestSchema,
  EditorSetDirtyRequestSchema,
  FlowEndedEventSchema,
  GrabFramesEventSchema,
  OverlayConfirmRequestSchema,
  OverlayInitSchema,
  OverlayPickDisplayRequestSchema,
  ShotCopyRequestSchema,
  ShotExportRequestSchema,
  ShotExportResponseSchema,
  ShotGetRequestSchema,
  ShotGetResponseSchema,
  ShotReadyEventSchema,
  ShowItemInFolderRequestSchema,
  StartScreenshotRequestSchema,
  WorkerFrameErrorSchema,
  WorkerFrameResultSchema,
} from './shot-ipc';
import {
  AppendChunkRequestSchema,
  AppendChunkResponseSchema,
  EngineCommandSchema,
  EngineEventSchema,
  FinishSessionRequestSchema,
  FinishSessionResponseSchema,
  LevelsEventSchema,
  RecorderSnapshotSchema,
  RecorderStartRequestSchema,
  RecordingIdRequestSchema,
  ResolveChoiceRequestSchema,
  ToggleMuteRequestSchema,
} from './recorder-ipc';
import {
  ExportCancelRequestSchema,
  ExportCapabilitiesSchema,
  ExportDoneEventSchema,
  ExportFailedEventSchema,
  ExportMp4RequestSchema,
  ExportMp4ResponseSchema,
  ExportProgressEventSchema,
  HistoryCancelledSchema,
  HistoryIdRequestSchema,
  HistoryListRequestSchema,
  HistoryListResponseSchema,
} from './history-ipc';
import {
  RecoverResponseSchema,
  RecoveryListResponseSchema,
  RecoverySessionIdSchema,
} from './recovery-ipc';
import {
  ChooseOutputDirResponseSchema,
  OutputTargetRequestSchema,
  ResolveQuitRequestSchema,
  SettingsResetRequestSchema,
  SettingsStateSchema,
  SettingsUpdateRequestSchema,
  ShortcutPauseRequestSchema,
  ShortcutStatesSchema,
  ShortcutValidateRequestSchema,
  ShortcutValidateResponseSchema,
  NavigateEventSchema,
  StartRequestEventSchema,
  ToastEventSchema,
} from './settings-ipc';
import { ROLES, type Role } from './types';

const ALL_ROLES: readonly Role[] = ROLES;

export const AppInfoSchema = z.object({
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  isPackaged: z.boolean(),
  /** The system tray icon: absent (active false) when Windows has no tray to show it in. */
  tray: z.object({
    active: z.boolean(),
    bounds: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .nullable(),
  }),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** Length caps keep a misbehaving renderer from flooding the log. */
export const ERROR_REPORT_LIMITS = { message: 2000, stack: 8000, componentStack: 8000 } as const;

export const ReportErrorSchema = z.strictObject({
  source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']),
  message: z.string().max(ERROR_REPORT_LIMITS.message),
  stack: z.string().max(ERROR_REPORT_LIMITS.stack).optional(),
  componentStack: z.string().max(ERROR_REPORT_LIMITS.componentStack).optional(),
});
export type ReportErrorRequest = z.infer<typeof ReportErrorSchema>;

export interface ChannelDef {
  /** Validates the payload in main. `z.undefined()` for channels with no payload. */
  request: z.ZodType;
  /** Describes the data inside `{ ok: true, data }`. */
  response: z.ZodType;
  /** Window roles allowed to call the channel. Enforced in main. */
  roles: readonly Role[];
}

/**
 * The single source of truth for invoke channels: channel -> { request schema, response type,
 * roles }. Later phases add entries here; main, preload and renderer types follow automatically.
 */
export const ipcContract = {
  'app:getInfo': {
    request: z.undefined(),
    response: AppInfoSchema,
    roles: ['main'],
  },
  'app:reportError': {
    request: ReportErrorSchema,
    response: z.void(),
    roles: ALL_ROLES,
  },
  'capture:listDisplays': {
    request: z.undefined(),
    response: z.array(DisplayInfoSchema),
    roles: ['main'],
  },
  'capture:listSources': {
    request: ListSourcesRequestSchema,
    response: z.array(SourceInfoSchema),
    roles: ['main'],
  },
  'capture:grant': {
    request: CaptureGrantRequestSchema,
    response: CaptureGrantResponseSchema,
    roles: ['main', 'recorder'],
  },
  'diagnostics:saveRecording': {
    request: SaveDiagnosticsRequestSchema,
    response: SaveDiagnosticsResponseSchema,
    roles: ['main'],
  },
  'capture:startScreenshot': {
    request: StartScreenshotRequestSchema,
    response: z.object({ started: z.literal(true) }),
    roles: ['main'],
  },
  'shot:get': {
    request: ShotGetRequestSchema,
    response: ShotGetResponseSchema,
    roles: ['main'],
  },
  'shot:export': {
    request: ShotExportRequestSchema,
    response: ShotExportResponseSchema,
    roles: ['main'],
  },
  'shot:copy': {
    request: ShotCopyRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'shot:discard': {
    request: ShotGetRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'editor:setDirty': {
    request: EditorSetDirtyRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'editor:resolveClose': {
    request: EditorResolveCloseRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'shell:showItemInFolder': {
    request: ShowItemInFolderRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'overlay:getInit': {
    request: z.undefined(),
    response: OverlayInitSchema,
    roles: ['overlay'],
  },
  'overlay:ready': {
    request: z.undefined(),
    response: z.void(),
    roles: ['overlay'],
  },
  'overlay:selectionStarted': {
    request: z.undefined(),
    response: z.void(),
    roles: ['overlay'],
  },
  'overlay:confirm': {
    request: OverlayConfirmRequestSchema,
    response: z.void(),
    roles: ['overlay'],
  },
  'overlay:cancel': {
    request: z.undefined(),
    response: z.void(),
    roles: ['overlay'],
  },
  'overlay:pickDisplay': {
    request: OverlayPickDisplayRequestSchema,
    response: z.void(),
    roles: ['overlay'],
  },
  'worker:ready': {
    request: z.undefined(),
    response: z.void(),
    roles: ['recorder'],
  },
  'worker:frameResult': {
    request: WorkerFrameResultSchema,
    response: z.void(),
    roles: ['recorder'],
  },
  'worker:frameError': {
    request: WorkerFrameErrorSchema,
    response: z.void(),
    roles: ['recorder'],
  },
  'diagnostics:revealFolder': {
    request: z.undefined(),
    response: z.void(),
    roles: ['main'],
  },
  // --- recording (phase 05). Main owns the state; every UI sends commands through main. ---
  'recorder:start': {
    request: RecorderStartRequestSchema,
    response: z.object({ started: z.literal(true), sessionId: z.string() }),
    roles: ['main'],
  },
  'recorder:pause': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'recorder:resume': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'recorder:stop': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'recorder:cancel': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'recorder:toggleMute': {
    request: ToggleMuteRequestSchema,
    response: z.void(),
    roles: ['main', 'toolbar'],
  },
  /** The toolbar reports the width its content needs; main sizes the window to it (no clipping). */
  'toolbar:resize': {
    request: z.strictObject({ width: z.number().min(120).max(900) }),
    response: z.void(),
    roles: ['toolbar'],
  },
  'recorder:getState': {
    request: z.undefined(),
    response: RecorderSnapshotSchema,
    roles: ['main', 'toolbar', 'recorder', 'countdown'],
  },
  'recorder:resolveChoice': {
    request: ResolveChoiceRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'recorder:reset': { request: z.undefined(), response: z.void(), roles: ['main'] },
  'recorder:showInFolder': {
    request: RecordingIdRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'recorder:copyPath': { request: RecordingIdRequestSchema, response: z.void(), roles: ['main'] },
  'recorder:engineEvent': { request: EngineEventSchema, response: z.void(), roles: ['recorder'] },
  'session:appendChunk': {
    request: AppendChunkRequestSchema,
    response: AppendChunkResponseSchema,
    roles: ['recorder'],
  },
  'session:finish': {
    request: FinishSessionRequestSchema,
    response: FinishSessionResponseSchema,
    roles: ['recorder'],
  },
  // --- recovery of unfinished recordings (phase 06) ---
  'recovery:list': {
    request: z.undefined(),
    response: RecoveryListResponseSchema,
    roles: ['main'],
  },
  'recovery:recover': {
    request: RecoverySessionIdSchema,
    response: RecoverResponseSchema,
    roles: ['main'],
  },
  'recovery:discard': { request: RecoverySessionIdSchema, response: z.void(), roles: ['main'] },
  'recovery:reveal': { request: RecoverySessionIdSchema, response: z.void(), roles: ['main'] },
  // --- local history and video export (phase 07). Everything goes by history id, never by path. ---
  'history:list': {
    request: HistoryListRequestSchema,
    response: HistoryListResponseSchema,
    roles: ['main'],
  },
  /** True once after a damaged history file was set aside at startup (the UI then says so). */
  'history:consumeNotice': {
    request: z.undefined(),
    response: z.object({ reset: z.boolean() }),
    roles: ['main'],
  },
  'history:open': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  'history:reveal': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  'history:copyImage': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  'history:copyPath': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Removes the entry only; the file stays. */
  'history:remove': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Puts an entry removed in the last seconds back (main remembers it; the renderer sends no data). */
  'history:undoRemove': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Moves the file to the Recycle Bin and removes the entry. A separate, confirmed action. */
  'history:deleteFile': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Opens a file dialog in main to point a missing entry at its moved file. */
  'history:relink': {
    request: HistoryIdRequestSchema,
    response: z.union([z.object({ relinked: z.literal(true) }), HistoryCancelledSchema]),
    roles: ['main'],
  },
  'history:clearMissing': {
    request: z.undefined(),
    response: z.object({ removed: z.number() }),
    roles: ['main'],
  },
  /** Recordings: "Save a copy as..." of the finished WebM (a save dialog in main). */
  'history:saveCopy': {
    request: HistoryIdRequestSchema,
    response: z.union([z.object({ path: z.string() }), HistoryCancelledSchema]),
    roles: ['main'],
  },
  'export:capabilities': {
    request: z.undefined(),
    response: ExportCapabilitiesSchema,
    roles: ['main'],
  },
  'export:mp4': {
    request: ExportMp4RequestSchema,
    response: ExportMp4ResponseSchema,
    roles: ['main'],
  },
  'export:cancel': { request: ExportCancelRequestSchema, response: z.void(), roles: ['main'] },
  // --- settings, shortcuts and the app lifecycle (phase 08) ---
  'settings:get': { request: z.undefined(), response: SettingsStateSchema, roles: ['main'] },
  'settings:update': {
    request: SettingsUpdateRequestSchema,
    response: SettingsStateSchema,
    roles: ['main'],
  },
  'settings:reset': {
    request: SettingsResetRequestSchema,
    response: SettingsStateSchema,
    roles: ['main'],
  },
  /** A folder dialog in main; the chosen folder must be writable (a probe file is written). */
  'settings:chooseOutputDir': {
    request: OutputTargetRequestSchema,
    response: ChooseOutputDirResponseSchema,
    roles: ['main'],
  },
  'settings:useDefaultOutputDir': {
    request: OutputTargetRequestSchema,
    response: SettingsStateSchema,
    roles: ['main'],
  },
  'settings:openOutputDir': {
    request: OutputTargetRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  /** True once after a damaged settings file was set aside at startup. */
  'settings:consumeNotice': {
    request: z.undefined(),
    response: z.object({ reset: z.boolean() }),
    roles: ['main'],
  },
  'shortcuts:status': { request: z.undefined(), response: ShortcutStatesSchema, roles: ['main'] },
  'shortcuts:validate': {
    request: ShortcutValidateRequestSchema,
    response: ShortcutValidateResponseSchema,
    roles: ['main'],
  },
  /** The shortcut recorder asks for the global shortcuts to be released while it listens. */
  'shortcuts:setPaused': {
    request: ShortcutPauseRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  'app:resolveQuit': { request: ResolveQuitRequestSchema, response: z.void(), roles: ['main'] },
} as const satisfies Record<string, ChannelDef>;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>;
export type IpcParsedRequest<C extends IpcChannel> = z.output<IpcContract[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>;

/** Main -> renderer events. The preload only allows subscribing to these. */
export const ipcEvents = {
  'app:themeChanged': z.object({ dark: z.boolean() }),
  'shot:ready': ShotReadyEventSchema,
  'capture:flowEnded': FlowEndedEventSchema,
  /** The main window was asked to close while the editor has unsaved work. */
  'app:confirmClose': z.object({}),
  'overlay:clearSelection': z.object({}),
  'worker:grabFrames': GrabFramesEventSchema,
  /** The authoritative recorder state, to the main, toolbar and recorder windows. */
  'recorder:state': RecorderSnapshotSchema,
  /** Mic and system levels (0..1) for the toolbar meters; only while recording. */
  'recorder:levels': LevelsEventSchema,
  /** The list of unfinished recordings may have changed (the startup scan finished). */
  'recovery:changed': z.object({}),
  /** History changed (an item was added, removed or got its thumbnail): lists should reload. */
  'history:changed': z.object({}),
  'export:progress': ExportProgressEventSchema,
  'export:done': ExportDoneEventSchema,
  'export:failed': ExportFailedEventSchema,
  /** Settings changed (any window's change, a reset, a repaired file). */
  'settings:changed': SettingsStateSchema,
  'shortcuts:changed': ShortcutStatesSchema,
  /** Quit was requested during a recording: ask whether to stop it and quit. */
  'app:confirmQuit': z.object({}),
  /** A tray or shortcut action that needs the main window (a window picker, an unsaved editor). */
  'app:startRequest': StartRequestEventSchema,
  'app:toast': ToastEventSchema,
  /** The tray menu asks the main window to show a view. */
  'app:navigate': NavigateEventSchema,
  /** Main -> the hidden recorder window: what the engine should do. */
  'recorder:engineCommand': EngineCommandSchema,
} as const satisfies Record<string, z.ZodType>;

export type IpcEvent = keyof typeof ipcEvents;
export type IpcEventPayload<E extends IpcEvent> = z.output<(typeof ipcEvents)[E]>;

export const IPC_CHANNELS = Object.keys(ipcContract) as IpcChannel[];
export const IPC_EVENTS = Object.keys(ipcEvents) as IpcEvent[];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.hasOwn(ipcContract, value);
}

export function isIpcEvent(value: unknown): value is IpcEvent {
  return typeof value === 'string' && Object.hasOwn(ipcEvents, value);
}
