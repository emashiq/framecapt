import { handle } from '../ipc';
import type { VideoEditService } from './service';

/**
 * The video editor's channels. Every call goes by history id: main resolves the file itself, so a
 * renderer can neither name a path nor reach a file that is not in history. Cancelling an export
 * uses `export:cancel` (the job queue is shared).
 */
export function registerVideoHandlers(service: VideoEditService): void {
  handle('video:open', { roles: ['main'] }, (request) => service.open(request.historyId));
  handle('video:save', { roles: ['main'] }, (request) =>
    service.save(request.historyId, request.project),
  );
  handle('video:export', { roles: ['main'] }, (request) =>
    service.export(request.historyId, request.project, request.format),
  );
}
