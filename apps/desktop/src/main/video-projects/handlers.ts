import { dialog } from 'electron';
import { AUDIO_EXTENSIONS } from '../../shared/video-edit';
import { handle } from '../ipc';
import { dialogParent } from '../windows';
import type { VideoEditService } from './service';

/** The Open dialog for an audio file (a main-process dialog; the path never reaches a renderer). */
export async function pickAudioFile(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Add audio',
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }],
    properties: ['openFile'],
  };
  const parent = dialogParent();
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  return result.canceled || !file ? null : file;
}

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
  handle('video:addImage', { roles: ['main'] }, (request) =>
    service.addImage(request.historyId, new Uint8Array(request.png)),
  );
  handle('video:pickAudio', { roles: ['main'] }, (request) => service.pickAudio(request.historyId));
  handle('video:export', { roles: ['main'] }, (request) =>
    service.export(
      request.historyId,
      request.project,
      request.format,
      request.overlays.map((overlay) => ({
        itemId: overlay.itemId,
        png: new Uint8Array(overlay.png),
      })),
    ),
  );
}
