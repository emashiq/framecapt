import { shell } from 'electron';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import type { LibraryService } from './service';

/**
 * Library channels. The renderer sends relative folder names (validated against the shared grammar
 * by the contract schema) and history ids; the service resolves them under the fixed capture
 * folders. No path ever comes from the renderer.
 */
export function registerLibraryHandlers(library: LibraryService): void {
  handle('library:tree', { roles: ['main'] }, () => library.tree());
  handle('library:createFolder', { roles: ['main'] }, (request) =>
    library.createFolder(request.folder),
  );
  handle('library:renameFolder', { roles: ['main'] }, (request) =>
    library.renameFolder(request.folder, request.name),
  );
  handle('library:deleteFolder', { roles: ['main'] }, (request) =>
    library.deleteFolder(request.folder),
  );
  handle('library:moveContentsUp', { roles: ['main'] }, (request) =>
    library.moveContentsUp(request.folder),
  );
  handle('library:moveItems', { roles: ['main'] }, (request) =>
    library.moveItems(request.ids, request.folder),
  );
  handle('library:setCaptureFolder', { roles: ['main'] }, (request) =>
    library.setCaptureFolder(request.folder),
  );
  handle('library:reveal', { roles: ['main'] }, async (request) => {
    const dir = await library.directory(request.root, request.folder);
    if (!dir) throw new IpcError('NOT_FOUND', 'That folder does not exist there yet.');
    const failure = await shell.openPath(dir);
    if (failure) throw new IpcError('INTERNAL', 'The folder could not be opened.');
  });
}
