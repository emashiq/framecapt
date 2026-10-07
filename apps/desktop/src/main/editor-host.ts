import path from 'node:path';
import type { EditorOpenRequest, EditorOpenTabEvent } from '../shared/editor-ipc';
import type { HistoryService } from './history/service';
import { sendEvent } from './events';
import { handle } from './ipc';
import { IpcError } from './ipc-core';
import type { ShotSessionStore } from './shots/session-store';
import {
  createEditorWindow,
  getEditorState,
  getEditorWindow,
  onEditorWindowClosed,
  resolveEditorClose,
  setEditorState,
  showEditorWindow,
} from './windows';

/** The recordings the video editor can open (the same list History offers "Edit video" for). */
const EDITABLE_VIDEO_FORMATS: readonly string[] = ['webm', 'mp4', 'fcap'];

/**
 * Tabs asked for while the Editor window's renderer is not listening yet (the window is being
 * made). `editor:ready` hands them over in order; a window that closes drops what it never saw.
 */
let listening = false;
const waiting: EditorOpenTabEvent[] = [];
onEditorWindowClosed(() => {
  listening = false;
  waiting.length = 0;
});

/** Opens (or focuses) a tab: the window is made on first use and brought to the front every time. */
export function openEditorTab(event: EditorOpenTabEvent): void {
  const existing = showEditorWindow();
  if (existing && listening) {
    sendEvent(existing.webContents, 'editor:openTab', event);
    return;
  }
  waiting.push(event);
  if (!existing) createEditorWindow();
}

/**
 * The Editor window's channels. A request names a session or a history id; main works out what it
 * is (screenshot or recording, its file name) and tells the window what to open.
 */
export function registerEditorHandlers(
  store: Pick<ShotSessionStore, 'get'>,
  history: Pick<HistoryService, 'get'>,
): void {
  handle('editor:open', { roles: ['main'] }, (request) => {
    openEditorTab(resolveRequest(request, store, history));
  });

  handle('editor:ready', { roles: ['editor'] }, () => {
    const win = getEditorWindow();
    if (!win) return;
    listening = true;
    for (const event of waiting.splice(0)) sendEvent(win.webContents, 'editor:openTab', event);
  });

  handle('editor:setState', { roles: ['editor'] }, (request) => {
    setEditorState(request);
    // The last tab was closed: the window has nothing left to show.
    if (request.tabs === 0) getEditorWindow()?.close();
  });

  handle('editor:resolveClose', { roles: ['editor'] }, (request) => {
    resolveEditorClose(request.discard);
  });

  handle('editor:show', { roles: ['main'] }, () => {
    showEditorWindow();
  });

  handle('editor:getState', { roles: ['main'] }, () => getEditorState());
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
    // A guide's history item points at its flow.json: the folder carries the name.
    const guide =
      title.toLowerCase() === 'flow.json' ? path.basename(path.dirname(item.path)) : title;
    return {
      kind: 'step',
      historyId: item.id,
      index: request.index,
      title: `${guide} (step ${request.index + 1})`,
    };
  }
  if (item.type === 'screenshot') return { kind: 'shot', historyId: item.id, title };
  if (item.type === 'recording' && EDITABLE_VIDEO_FORMATS.includes(item.format)) {
    return { kind: 'video', historyId: item.id, title };
  }
  throw new IpcError('INVALID_PAYLOAD', 'That item cannot be edited.');
}
