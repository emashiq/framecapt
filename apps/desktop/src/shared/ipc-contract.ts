import { z } from 'zod';
import { CameraSetStyleRequestSchema, CameraStyleStateSchema } from './camera';
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
  EditorOpenRequestSchema,
  EditorOpenTabEventSchema,
  EditorResolveCloseRequestSchema,
  EditorStateSchema,
} from './editor-ipc';
import {
  FlowEndedEventSchema,
  GrabFramesEventSchema,
  HistoryImageRequestSchema,
  HistoryImageResponseSchema,
  OverlayConfirmRequestSchema,
  OverlayInitSchema,
  OverlayPickDisplayRequestSchema,
  PickImageResponseSchema,
  ShotCopyRequestSchema,
  ShotExportRequestSchema,
  ShotExportResponseSchema,
  ShotQuickSaveResponseSchema,
  ShotGetRequestSchema,
  ShotGetResponseSchema,
  ShotImportRequestSchema,
  ShotImportResponseSchema,
  ShowItemInFolderRequestSchema,
  StartScreenshotRequestSchema,
  WorkerFrameErrorSchema,
  WorkerFrameResultSchema,
} from './shot-ipc';
import {
  OpenFromHistoryRequestSchema,
  OpenFromHistoryResponseSchema,
  ShotSaveOverRequestSchema,
  ShotSaveOverResponseSchema,
} from './project-ipc';
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
  BulkExportRequestSchema,
  BulkExportResponseSchema,
  BulkProgressEventSchema,
  ExportCancelRequestSchema,
  ExportCapabilitiesSchema,
  ExportDoneEventSchema,
  ExportFailedEventSchema,
  ExportMp4RequestSchema,
  ExportMp4ResponseSchema,
  ExtractFcapRequestSchema,
  ExtractFcapResponseSchema,
  ExportProgressEventSchema,
  HistoryCancelledSchema,
  HistoryIdRequestSchema,
  HistoryListRequestSchema,
  HistoryListResponseSchema,
} from './history-ipc';
import {
  VideoExportDoneEventSchema,
  VideoExportFailedEventSchema,
  VideoExportProgressEventSchema,
  VideoExportRequestSchema,
  VideoAddImageRequestSchema,
  VideoAddImageResponseSchema,
  VideoExportResponseSchema,
  VideoPickAudioRequestSchema,
  VideoPickAudioResponseSchema,
  VideoOpenRequestSchema,
  VideoOpenResponseSchema,
  VideoSaveRequestSchema,
} from './video-ipc';
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
import {
  FlowExportRequestSchema,
  FlowExportResponseSchema,
  FlowGetRequestSchema,
  FlowGetResponseSchema,
  FlowOpenStepRequestSchema,
  FlowReadStepResponseSchema,
  FlowUpdateRequestSchema,
  StepsDoneResponseSchema,
  StepsFinishedEventSchema,
  StepsSetAutoRequestSchema,
  StepsSnapshotSchema,
} from './flow-ipc';
import { ROLES, type Role } from './types';

const ALL_ROLES: readonly Role[] = ROLES;

/**
 * Where the update adapter stands (src/main/updates.ts). `unconfigured` is the state of every
 * build without a compiled-in update feed: no update code runs and nothing touches the network.
 */
export const UpdateStatusSchema = z.object({
  state: z.enum(['unconfigured', 'idle', 'checking', 'available', 'downloading', 'ready', 'error']),
  message: z.string().max(500).optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

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
  updates: UpdateStatusSchema,
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
  /** File, Quit: the tray's Quit path (asks first while a recording runs). */
  'app:requestQuit': {
    request: z.undefined(),
    response: z.void(),
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
    roles: ['editor'],
  },
  'shot:export': {
    request: ShotExportRequestSchema,
    response: ShotExportResponseSchema,
    roles: ['editor'],
  },
  /** Quick save: writes the export payload to the screenshots folder under a free name, no dialog. */
  'shot:quickSave': {
    request: ShotExportRequestSchema,
    response: ShotQuickSaveResponseSchema,
    roles: ['editor'],
  },
  /** Saves over the history item the editor was opened from (atomic; no dialog). */
  'shot:saveOver': {
    request: ShotSaveOverRequestSchema,
    response: ShotSaveOverResponseSchema,
    roles: ['editor'],
  },
  /** Opens an owned screenshot of history in a new editor session (project or flattened copy). */
  'shot:openFromHistory': {
    request: OpenFromHistoryRequestSchema,
    response: OpenFromHistoryResponseSchema,
    roles: ['editor'],
  },
  /** File > Open image: a main-process dialog; returns the picked picture's validated bytes. */
  'shot:openImage': {
    request: z.undefined(),
    response: PickImageResponseSchema,
    roles: ['main', 'editor'],
  },
  /** Starts an editor session from a PNG the renderer made from a picture (opened, dropped, pasted). */
  'shot:importImage': {
    request: ShotImportRequestSchema,
    response: ShotImportResponseSchema,
    roles: ['main', 'editor'],
  },
  /** Insert image > From file: the same dialog, for an image layer inside the open editor. */
  'editor:pickImage': {
    request: z.undefined(),
    response: PickImageResponseSchema,
    roles: ['editor'],
  },
  /** Insert image > From History: the picture of an owned screenshot, as PNG. */
  'editor:historyImage': {
    request: HistoryImageRequestSchema,
    response: HistoryImageResponseSchema,
    roles: ['editor'],
  },
  'shot:copy': {
    request: ShotCopyRequestSchema,
    response: z.void(),
    roles: ['editor'],
  },
  'shot:discard': {
    request: ShotGetRequestSchema,
    response: z.void(),
    roles: ['main', 'editor'],
  },
  // --- the Editor window: one window, one tab per open screenshot or video ---
  /** Opens (or focuses) a tab of the Editor window, creating the window on first use. */
  'editor:open': {
    request: EditorOpenRequestSchema,
    response: z.void(),
    roles: ['main'],
  },
  /** The Editor window's renderer is listening: main sends the tabs that were requested before. */
  'editor:ready': {
    request: z.undefined(),
    response: z.void(),
    roles: ['editor'],
  },
  /** The Editor window reports its tab count and whether closing would lose work. */
  'editor:setState': {
    request: EditorStateSchema,
    response: z.void(),
    roles: ['editor'],
  },
  /** The answer to `editor:confirmClose`. */
  'editor:resolveClose': {
    request: EditorResolveCloseRequestSchema,
    response: z.void(),
    roles: ['editor'],
  },
  /** Brings the Editor window to the front (the main window's "Editor" button). */
  'editor:show': {
    request: z.undefined(),
    response: z.void(),
    roles: ['main'],
  },
  /** The tab count of the Editor window, for the main window's button. */
  'editor:getState': {
    request: z.undefined(),
    response: EditorStateSchema,
    roles: ['main'],
  },
  'shell:showItemInFolder': {
    request: ShowItemInFolderRequestSchema,
    response: z.void(),
    roles: ['main', 'editor'],
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
  /** A screenshot of what is being recorded, saved straight to the screenshots folder. */
  'recorder:screenshot': { request: z.undefined(), response: z.void(), roles: ['toolbar'] },
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
  /** The toolbar's camera button: show or hide the camera bubble (and its picture in the video). */
  'recorder:toggleCamera': { request: z.undefined(), response: z.void(), roles: ['toolbar'] },
  /** The camera bubble reports a change of its own size, shape or visibility. */
  'camera:setStyle': {
    request: CameraSetStyleRequestSchema,
    response: CameraStyleStateSchema,
    roles: ['camera'],
  },
  /** The camera bubble asks what to show (device, shape, size). */
  'camera:getStyle': {
    request: z.undefined(),
    response: CameraStyleStateSchema,
    roles: ['camera'],
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
    roles: ['main', 'editor'],
  },
  /** True once after a damaged history file was set aside at startup (the UI then says so). */
  'history:consumeNotice': {
    request: z.undefined(),
    response: z.object({ reset: z.boolean() }),
    roles: ['main'],
  },
  'history:open': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  'history:reveal': {
    request: HistoryIdRequestSchema,
    response: z.void(),
    roles: ['main', 'editor'],
  },
  'history:copyImage': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  'history:copyPath': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Removes the entry only; the file stays. */
  'history:remove': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Puts an entry removed in the last seconds back (main remembers it; the renderer sends no data). */
  'history:undoRemove': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Deletes the editable project (unredacted original and annotations) of an item; the exported image stays. */
  'history:deleteProject': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Moves the file to the Recycle Bin and removes the entry. A separate, confirmed action. */
  'history:deleteFile': {
    request: HistoryIdRequestSchema,
    response: z.void(),
    roles: ['main', 'editor'],
  },
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
  /** Adds captures found in the output folders that history does not list (files only read). */
  'history:rescan': {
    request: z.undefined(),
    response: z.object({ added: z.number() }),
    roles: ['main'],
  },
  /** Recordings: "Save a copy as..." of the finished WebM (a save dialog in main). */
  'history:saveCopy': {
    request: HistoryIdRequestSchema,
    response: z.union([z.object({ path: z.string() }), HistoryCancelledSchema]),
    roles: ['main'],
  },
  /** Drag-out: starts an OS file drag of an owned item's file (main resolves the path). */
  'history:startDrag': { request: HistoryIdRequestSchema, response: z.void(), roles: ['main'] },
  /** Saves copies of owned items into one folder chosen in a main dialog; never overwrites. */
  'history:exportMany': {
    request: BulkExportRequestSchema,
    response: BulkExportResponseSchema,
    roles: ['main'],
  },
  /** Cancels the running "save copies" (the rest are skipped). */
  'history:cancelBulk': { request: z.undefined(), response: z.void(), roles: ['main'] },
  /** Multi-source recordings (`.fcap`): extracts one source or the whole picture, between two times. */
  'history:extractFcap': {
    request: ExtractFcapRequestSchema,
    response: ExtractFcapResponseSchema,
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
  'export:cancel': {
    request: ExportCancelRequestSchema,
    response: z.void(),
    roles: ['main', 'editor'],
  },
  // --- video editor: the saved project (a recipe, the video is never changed) and its export ---
  'video:open': {
    request: VideoOpenRequestSchema,
    response: VideoOpenResponseSchema,
    roles: ['editor'],
  },
  'video:save': { request: VideoSaveRequestSchema, response: z.void(), roles: ['editor'] },
  /** Stores a picture (PNG bytes) as an asset of the project and returns its id (its SHA-256). */
  'video:addImage': {
    request: VideoAddImageRequestSchema,
    response: VideoAddImageResponseSchema,
    roles: ['editor'],
  },
  /** An Open dialog in main for an audio file; the file is copied into the project's assets. */
  'video:pickAudio': {
    request: VideoPickAudioRequestSchema,
    response: VideoPickAudioResponseSchema,
    roles: ['editor'],
  },
  /** Renders the edit into a new file next to the source (a queued job; cancel with export:cancel). */
  'video:export': {
    request: VideoExportRequestSchema,
    response: VideoExportResponseSchema,
    roles: ['editor'],
  },
  // --- settings, shortcuts and the app lifecycle (phase 08) ---
  'settings:get': {
    request: z.undefined(),
    response: SettingsStateSchema,
    roles: ['main', 'editor'],
  },
  'settings:update': {
    request: SettingsUpdateRequestSchema,
    response: SettingsStateSchema,
    roles: ['main', 'editor'],
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
  'shortcuts:status': {
    request: z.undefined(),
    response: ShortcutStatesSchema,
    roles: ['main', 'editor'],
  },
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
  // --- step guides: capturing (the pill and the main window) and the Flow view ---
  'steps:start': { request: z.undefined(), response: z.void(), roles: ['main'] },
  'steps:getState': {
    request: z.undefined(),
    response: StepsSnapshotSchema,
    roles: ['main', 'toolbar'],
  },
  /** A step now, at the pointer's current place. */
  'steps:captureStep': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'steps:pause': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'steps:resume': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'steps:setAuto': {
    request: StepsSetAutoRequestSchema,
    response: z.void(),
    roles: ['main', 'toolbar'],
  },
  /** Saves the guide (a folder of step images and flow.json in the screenshots folder). */
  'steps:done': {
    request: z.undefined(),
    response: StepsDoneResponseSchema,
    roles: ['main', 'toolbar'],
  },
  /** Throws the steps away (the pill asks first). */
  'steps:cancel': { request: z.undefined(), response: z.void(), roles: ['main', 'toolbar'] },
  'flow:get': { request: FlowGetRequestSchema, response: FlowGetResponseSchema, roles: ['main'] },
  'flow:update': {
    request: FlowUpdateRequestSchema,
    response: FlowGetResponseSchema,
    roles: ['main'],
  },
  /** Opens one step in the screenshot editor; Save writes over that step's image. */
  'flow:openStepInEditor': {
    request: FlowOpenStepRequestSchema,
    response: OpenFromHistoryResponseSchema,
    roles: ['editor'],
  },
  /** One step's PNG bytes, for drawing the exports in the renderer. */
  'flow:readStep': {
    request: FlowOpenStepRequestSchema,
    response: FlowReadStepResponseSchema,
    roles: ['main'],
  },
  'flow:export': {
    request: FlowExportRequestSchema,
    response: FlowExportResponseSchema,
    roles: ['main'],
  },
} as const satisfies Record<string, ChannelDef>;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>;
export type IpcParsedRequest<C extends IpcChannel> = z.output<IpcContract[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>;

/** Main -> renderer events. The preload only allows subscribing to these. */
export const ipcEvents = {
  'app:themeChanged': z.object({ dark: z.boolean() }),
  /** Open (or focus) this tab in the Editor window. */
  'editor:openTab': EditorOpenTabEventSchema,
  /** The Editor window's tab count or unsaved state changed (to the main window's button). */
  'editor:stateChanged': EditorStateSchema,
  'capture:flowEnded': FlowEndedEventSchema,
  /** The Editor window was asked to close (or the app to quit) while tabs have unsaved work. */
  'editor:confirmClose': z.object({}),
  'overlay:clearSelection': z.object({}),
  'worker:grabFrames': GrabFramesEventSchema,
  /** The authoritative recorder state, to the main, toolbar and recorder windows. */
  'recorder:state': RecorderSnapshotSchema,
  /** Mic and system levels (0..1) for the toolbar meters; only while recording. */
  'recorder:levels': LevelsEventSchema,
  /** The result of a screenshot taken during a recording, for the toolbar's inline status. */
  'recorder:toast': ToastEventSchema,
  /** The list of unfinished recordings may have changed (the startup scan finished). */
  'recovery:changed': z.object({}),
  /** History changed (an item was added, removed or got its thumbnail): lists should reload. */
  'history:changed': z.object({}),
  /** Progress of "save copies" (items finished of the total). */
  'history:bulkProgress': BulkProgressEventSchema,
  'export:progress': ExportProgressEventSchema,
  'export:done': ExportDoneEventSchema,
  'export:failed': ExportFailedEventSchema,
  'video:exportProgress': VideoExportProgressEventSchema,
  'video:exportDone': VideoExportDoneEventSchema,
  'video:exportFailed': VideoExportFailedEventSchema,
  /** Settings changed (any window's change, a reset, a repaired file). */
  'settings:changed': SettingsStateSchema,
  'shortcuts:changed': ShortcutStatesSchema,
  /** Quit was requested during a recording: ask whether to stop it and quit. */
  'app:confirmQuit': z.object({}),
  /** A tray or shortcut action that needs the main window (a window picker). */
  'app:startRequest': StartRequestEventSchema,
  'app:toast': ToastEventSchema,
  /** The tray menu asks the main window to show a view. */
  'app:navigate': NavigateEventSchema,
  /** The authoritative step-capture state, to the main window and the Steps pill. */
  'steps:state': StepsSnapshotSchema,
  /** A guide was saved: the main window opens it. */
  'steps:finished': StepsFinishedEventSchema,
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
