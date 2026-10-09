import { clipboard, shell } from 'electron';
import { handle, type HandlerContext } from '../ipc';
import { IpcError } from '../ipc-core';
import type { MediaRegistry } from '../recording/media-protocol';
import type { SessionService } from '../recording/session-service';
import type { RecorderController } from './controller';
import { Cancelled } from './recording-session';

/**
 * Recording channels. Commands from every UI (main window, toolbar; later the tray and global
 * shortcuts) land here and go to the one controller in main. The recorder window reports through
 * `recorder:engineEvent` and sends its chunks through `session:*`; main owns every path.
 */
export function registerRecorderHandlers(
  controller: RecorderController,
  sessions: SessionService,
  media: MediaRegistry,
  /** The Steps pill shares the toolbar window role: its width requests come here too. */
  onStepsToolbarResize?: (width: number) => void,
  /** Pops the toolbar's menu (Electron-free here; the window and the menu belong to the caller). */
  onToolbarMenu?: (
    request: { menu: 'screenshot' | 'panel'; x: number; y: number },
    webContentsId: number,
  ) => Promise<void>,
  /** Pops the "Add panel" menu under the main window's button. */
  onPanelMenu?: (
    request: { sessionId?: string | undefined; x: number; y: number },
    webContentsId: number,
  ) => Promise<void>,
): void {
  /**
   * Which recording a command is for. A toolbar's command is for the recording that toolbar
   * belongs to (a `sessionId` it sends is ignored); the main window may name one, else the primary
   * one acts (undefined).
   */
  const sessionOf = (
    request: { sessionId?: string } | undefined,
    ctx: HandlerContext,
  ): string | undefined => {
    if (ctx.role !== 'toolbar') return request?.sessionId;
    const own = controller.sessionIdOf(ctx.webContentsId);
    if (!own) throw new IpcError('NOT_FOUND', 'There is no recording for this window.');
    return own;
  };

  handle('recorder:start', { roles: ['main'] }, async (request) => {
    const { sessionId } = await controller.start(request);
    return { started: true as const, sessionId };
  });
  handle('recorder:pause', { roles: ['main', 'toolbar'] }, (request, ctx) =>
    controller.pause(sessionOf(request, ctx)),
  );
  handle('recorder:resume', { roles: ['main', 'toolbar'] }, (request, ctx) =>
    controller.resume(sessionOf(request, ctx)),
  );
  // Stop answers at once; the outcome arrives as recorder:state (processing, then completed).
  handle('recorder:stop', { roles: ['main', 'toolbar'] }, (request, ctx) => {
    void controller.stop('user', sessionOf(request, ctx));
  });
  handle('recorder:stopAll', { roles: ['main'] }, () => {
    void controller.stopAll();
  });
  handle('recorder:screenshot', { roles: ['toolbar'] }, (request, ctx) =>
    controller.screenshotNow(sessionOf(request, ctx)),
  );
  handle('recorder:toolbarMenu', { roles: ['toolbar'] }, (request, ctx) =>
    onToolbarMenu?.(request, ctx.webContentsId),
  );
  handle('recorder:addPanel', { roles: ['main', 'toolbar'] }, async (request, ctx) => {
    try {
      return await controller.addPanel({ ...request, sessionId: sessionOf(request, ctx) });
    } catch (error) {
      // The user backed out of the region selection.
      if (error instanceof Cancelled)
        throw new IpcError('NOT_FOUND', 'The selection was cancelled.');
      throw error;
    }
  });
  handle('recorder:removePanel', { roles: ['main', 'toolbar'] }, (request, ctx) =>
    controller.removePanel(sessionOf(request, ctx), request.slot),
  );
  handle('recorder:setPanelHidden', { roles: ['main'] }, (request) =>
    controller.setPanelHidden(request.sessionId, request.slot, request.hidden, request.placeholder),
  );
  handle('recorder:panelMenu', { roles: ['main'] }, (request, ctx) =>
    onPanelMenu?.(request, ctx.webContentsId),
  );
  handle('recorder:cancel', { roles: ['main', 'toolbar'] }, (request, ctx) =>
    controller.cancel(sessionOf(request, ctx)),
  );
  handle('recorder:toggleMute', { roles: ['main', 'toolbar'] }, (request, ctx) =>
    controller.toggleMute(request.source, sessionOf(request, ctx)),
  );
  handle('toolbar:resize', { roles: ['toolbar'] }, (request, ctx) => {
    controller.resizeToolbar(request.width, ctx.webContentsId, request.height);
    onStepsToolbarResize?.(request.width);
  });
  handle('recorder:toggleCamera', { roles: ['toolbar'] }, (_request, ctx) =>
    controller.toggleCamera(sessionOf(undefined, ctx)),
  );
  handle('camera:getStyle', { roles: ['camera'] }, () => controller.cameraStyle());
  handle('camera:setStyle', { roles: ['camera'] }, (request) => controller.setCameraStyle(request));
  handle(
    'recorder:getState',
    { roles: ['main', 'toolbar', 'recorder', 'countdown'] },
    (_request, ctx) => controller.snapshotFor(ctx.role, ctx.webContentsId),
  );
  handle('recorder:resolveChoice', { roles: ['main'] }, (request) =>
    controller.resolveChoice(request.answer, request.sessionId),
  );
  handle('recorder:reset', { roles: ['main'] }, (request) => controller.reset(request?.sessionId));

  handle('recorder:showInFolder', { roles: ['main'] }, (request) => {
    const file = media.resolve(request.resultId);
    if (!file) throw new IpcError('NOT_FOUND', 'That recording is no longer available.');
    shell.showItemInFolder(file);
  });
  handle('recorder:copyPath', { roles: ['main'] }, (request) => {
    const file = media.resolve(request.resultId);
    if (!file) throw new IpcError('NOT_FOUND', 'That recording is no longer available.');
    clipboard.writeText(file);
  });

  // Each recording has its own recorder window: its events belong to that recording only.
  handle('recorder:engineEvent', { roles: ['recorder'] }, (event, ctx) => {
    controller.onEngineEvent(event, ctx.webContentsId);
  });
  // The recorder window that created a session is the only one that may write to it.
  handle('session:appendChunk', { roles: ['recorder'] }, (request, ctx) =>
    sessions.append(
      request.sessionId,
      request.seq,
      new Uint8Array(request.bytes),
      ctx.webContentsId,
      request.queued,
    ),
  );
  handle('session:finish', { roles: ['recorder'] }, (request, ctx) =>
    sessions.finish(request.sessionId, request.lastSeq, ctx.webContentsId),
  );
}
