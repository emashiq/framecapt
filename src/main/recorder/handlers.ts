import { clipboard, shell } from 'electron';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import type { MediaRegistry } from '../recording/media-protocol';
import type { SessionService } from '../recording/session-service';
import type { RecorderController } from './controller';

/**
 * Recording channels. Commands from every UI (main window, toolbar; later the tray and global
 * shortcuts) land here and go to the one controller in main. The recorder window reports through
 * `recorder:engineEvent` and sends its chunks through `session:*`; main owns every path.
 */
export function registerRecorderHandlers(
  controller: RecorderController,
  sessions: SessionService,
  media: MediaRegistry,
): void {
  handle('recorder:start', { roles: ['main'] }, async (request) => {
    const { sessionId } = await controller.start(request);
    return { started: true as const, sessionId };
  });
  handle('recorder:pause', { roles: ['main', 'toolbar'] }, () => controller.pause());
  handle('recorder:resume', { roles: ['main', 'toolbar'] }, () => controller.resume());
  // Stop answers at once; the outcome arrives as recorder:state (processing, then completed).
  handle('recorder:stop', { roles: ['main', 'toolbar'] }, () => {
    void controller.stop('user');
  });
  handle('recorder:cancel', { roles: ['main', 'toolbar'] }, () => controller.cancel());
  handle('recorder:toggleMute', { roles: ['main', 'toolbar'] }, (request) =>
    controller.toggleMute(request.source),
  );
  handle('toolbar:resize', { roles: ['toolbar'] }, (request) =>
    controller.resizeToolbar(request.width),
  );
  handle(
    'recorder:getState',
    { roles: ['main', 'toolbar', 'recorder', 'countdown'] },
    (_request, ctx) => controller.snapshotFor(ctx.role),
  );
  handle('recorder:resolveChoice', { roles: ['main'] }, (request) =>
    controller.resolveChoice(request.answer),
  );
  handle('recorder:reset', { roles: ['main'] }, () => controller.reset());

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

  handle('recorder:engineEvent', { roles: ['recorder'] }, (event) => {
    controller.onEngineEvent(event);
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
