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
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** Length caps keep a misbehaving renderer from flooding the log. */
export const ERROR_REPORT_LIMITS = { message: 2000, stack: 8000, componentStack: 8000 } as const;

export const ReportErrorSchema = z.object({
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
  'overlay:clearSelection': z.object({}),
  'worker:grabFrames': GrabFramesEventSchema,
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
