import path from 'node:path';
import type { EditorOpenRequest, EditorOpenTabEvent } from '../shared/editor-ipc';
import type { HistoryService } from './history/service';
import { sendEvent } from './events';
import { handle } from './ipc';
import { IpcError } from './ipc-core';
import type { ShotSessionStore } from './shots/session-store';
import type { BrowserWindow } from 'electron';
import { getMainWindow, resolveClose, setEditorDirty, showMainWindow } from './windows';

/** The recordings the video editor can open (the same list History offers "Edit video" for). */
const EDITABLE_VIDEO_FORMATS: readonly string[] = ['webm', 'mp4', 'fcap'];

/**
 * Tabs asked for while the main window's renderer is not listening yet (the window was just made).
 * `editor:ready` hands them over in order.
 */
let listeningWindow: BrowserWindow | undefined;
const waiting: EditorOpenTabEvent[] = [];

/** Opens (or focuses) a tab: the main window is brought to the front every time. */
export function openEditorTab(event: EditorOpenTabEvent): void {
  const existing = getMainWindow();
  const win = showMainWindow();
  if (existing && listeningWindow === win) sendEvent(win.webContents, 'editor:openTab', event);
  else waiting.push(event);
}

/**
 * The editor tabs' channels. A request names a session or a history id; main works out what it
 * is (screenshot or recording, its file name) and tells the main window what to open.
 */
export function registerEditorHandlers(
  store: Pick<ShotSessionStore, 'get'>,
  history: Pick<HistoryService, 'get'>,
): void {
  handle('editor:open', { roles: ['main'] }, (request) => {
    openEditorTab(resolveRequest(request, store, history));
  });

  handle('editor:ready', { roles: ['main'] }, () => {
    const win = getMainWindow();
    if (!win) return;
    listeningWindow = win;
    for (const event of waiting.splice(0)) sendEvent(win.webContents, 'editor:openTab', event);
  });

  handle('editor:setState', { roles: ['main'] }, (request) => {
    setEditorDirty(request.dirty);
  });

  handle('editor:resolveClose', { roles: ['main'] }, (request) => {
    resolveClose(request.discard);
  });
}

/** A guide's history item points at its flow.json: the folder carries the name. */
function guideName(file: string): string {
  const name = path.basename(file);
  return name.toLowerCase() === 'flow.json' ? path.basename(path.dirname(file)) : name;
}

function resolveRequest(
  request: EditorOpenRequest,
  store: Pick<ShotSessionStore, 'get'>,
  history: Pick<HistoryService, 'get'>,
): EditorOpenTabEvent {
  if (request.kind === 'session') {
    if (!store.get(request.sessionId)) {
      throw new IpcError('NOT_FOUND', 'That screenshot is no longer available.');
    }
    return {
      kind: 'session',
      sessionId: request.sessionId,
      ...(request.imported && { imported: true }),
    };
  }
  const item = history.get(request.historyId);
  if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
  const title = path.basename(item.path);
  if (request.kind === 'step') {
    if (item.type !== 'flow') throw new IpcError('INVALID_PAYLOAD', 'That is not a step guide.');
    const guide = guideName(item.path);
    return {
      kind: 'step',
      historyId: item.id,
      index: request.index,
      title: `${guide} (step ${request.index + 1})`,
    };
  }
  if (item.type === 'flow') {
    return { kind: 'flow', historyId: item.id, title: guideName(item.path) };
  }
  const viewer = request.viewer ? { viewer: true as const } : {};
  if (item.type === 'screenshot') return { kind: 'shot', historyId: item.id, title, ...viewer };
  if (item.type === 'recording' && EDITABLE_VIDEO_FORMATS.includes(item.format)) {
    return { kind: 'video', historyId: item.id, title, ...viewer };
  }
  throw new IpcError('INVALID_PAYLOAD', 'That item cannot be edited.');
}
