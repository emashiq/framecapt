import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, ClipboardItem, dialog, nativeImage, shell } from 'electron';
import { MAX_COPY_IMAGE_BYTES } from '../../shared/history-ipc';
import { detectImageFormat } from '../../shared/shots';
import { defaultRecordingFileName } from '../../shared/recording';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { Mp4Capability } from '../media/export';
import { getMainWindow } from '../windows';
import type { ExportService } from './export-service';
import { copyFileAtomic } from './files';
import type { HistoryService } from './service';

function requireItem(history: HistoryService, id: string) {
  const item = history.get(id);
  if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
  return item;
}

async function requireFile(file: string): Promise<void> {
  const present = await fs.promises.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );
  if (!present) throw new IpcError('NOT_FOUND', 'The file was moved or deleted.');
}

function withExtension(file: string, extension: string): string {
  return path.extname(file).toLowerCase() === extension ? file : `${file}${extension}`;
}

async function showSave(options: Electron.SaveDialogOptions): Promise<string | null> {
  const main = getMainWindow();
  const result = main
    ? await dialog.showSaveDialog(main, options)
    : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}

/** `Videos/Framelet` (made on demand) and a name next to the source's, with the extension swapped. */
export async function mp4SaveDialog(source: { path: string }): Promise<string | null> {
  const folder = path.join(app.getPath('videos'), 'Framelet');
  await fs.promises.mkdir(folder, { recursive: true });
  const base = path.basename(source.path, path.extname(source.path));
  const chosen = await showSave({
    title: 'Export as MP4',
    defaultPath: path.join(folder, `${base}.mp4`),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    properties: ['showOverwriteConfirmation'],
  });
  return chosen === null ? null : withExtension(chosen, '.mp4');
}

/**
 * History channels. Every action takes a history id; main looks the path up itself, so a
 * renderer can neither name a file nor reach one that is not in history.
 */
export function registerHistoryHandlers(
  history: HistoryService,
  exports: ExportService,
  capability: () => Promise<Mp4Capability>,
): void {
  handle('history:list', { roles: ['main'] }, (request) => history.list(request));
  handle('history:consumeNotice', { roles: ['main'] }, async () => ({
    reset: await history.consumeResetNotice(),
  }));

  handle('history:open', { roles: ['main'] }, async (request) => {
    const item = requireItem(history, request.id);
    await requireFile(item.path);
    const failure = await shell.openPath(item.path);
    if (failure) {
      log.warn(`openPath failed: ${failure}`);
      throw new IpcError('INTERNAL', 'The file could not be opened.');
    }
  });

  handle('history:reveal', { roles: ['main'] }, async (request) => {
    const item = requireItem(history, request.id);
    await requireFile(item.path);
    shell.showItemInFolder(item.path);
  });

  handle('history:copyPath', { roles: ['main'] }, (request) => {
    clipboard.writeText(requireItem(history, request.id).path);
  });

  handle('history:copyImage', { roles: ['main'] }, async (request) => {
    const item = requireItem(history, request.id);
    if (item.type !== 'screenshot') {
      throw new IpcError('INVALID_PAYLOAD', 'Only screenshots can be copied as an image.');
    }
    await requireFile(item.path);
    const { size } = await fs.promises.stat(item.path);
    if (size > MAX_COPY_IMAGE_BYTES)
      throw new IpcError('INVALID_PAYLOAD', 'The image is too large to copy.');
    const bytes = await fs.promises.readFile(item.path);
    const format = detectImageFormat(bytes);
    if (format === null)
      throw new IpcError('INVALID_PAYLOAD', 'The file is not a PNG or JPEG image.');
    // The clipboard takes PNG; a JPEG is decoded and re-encoded, a PNG is copied unchanged.
    const png =
      format === 'png' ? bytes : nativeImage.createFromBuffer(bytes, { scaleFactor: 1 }).toPNG();
    if (png.length === 0) throw new IpcError('INVALID_PAYLOAD', 'The image could not be read.');
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
    ]);
  });

  handle('history:remove', { roles: ['main'] }, (request) => history.remove(request.id));
  handle('history:undoRemove', { roles: ['main'] }, (request) => history.undoRemove(request.id));
  handle('history:deleteFile', { roles: ['main'] }, (request) => history.deleteFile(request.id));

  handle('history:relink', { roles: ['main'] }, async (request) => {
    const item = requireItem(history, request.id);
    const isImage = item.format === 'png' || item.format === 'jpeg';
    const options: Electron.OpenDialogOptions = {
      title: 'Locate the file',
      defaultPath: path.dirname(item.path),
      properties: ['openFile'],
      filters: [
        isImage
          ? { name: 'Images', extensions: item.format === 'png' ? ['png'] : ['jpg', 'jpeg'] }
          : { name: 'Video', extensions: [item.format] },
      ],
    };
    const main = getMainWindow();
    const result = main
      ? await dialog.showOpenDialog(main, options)
      : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { cancelled: true as const };
    await history.relink(request.id, picked);
    return { relinked: true as const };
  });

  handle('history:clearMissing', { roles: ['main'] }, async () => ({
    removed: await history.clearMissing(),
  }));

  // The finished WebM is already a complete file in Videos/Framelet; this only copies it.
  handle('history:saveCopy', { roles: ['main'] }, async (request) => {
    const item = requireItem(history, request.id);
    if (item.type !== 'recording') {
      throw new IpcError('INVALID_PAYLOAD', 'Only recordings can be saved as a copy.');
    }
    await requireFile(item.path);
    const extension = path.extname(item.path).toLowerCase();
    const folder = path.join(app.getPath('videos'), 'Framelet');
    await fs.promises.mkdir(folder, { recursive: true });
    const chosen = await showSave({
      title: 'Save a copy',
      defaultPath: path.join(
        folder,
        path.basename(item.path) || defaultRecordingFileName(new Date(item.createdAt)),
      ),
      filters: [
        {
          name: extension === '.mp4' ? 'MP4 video' : 'WebM video',
          extensions: [extension.slice(1)],
        },
      ],
      properties: ['showOverwriteConfirmation'],
    });
    if (chosen === null) return { cancelled: true as const };
    const target = withExtension(chosen, extension);
    try {
      await copyFileAtomic(item.path, target);
    } catch (error) {
      log.warn(`Save a copy failed (${(error as Error).message})`);
      throw new IpcError('INTERNAL', 'The copy could not be saved.');
    }
    return { path: target };
  });

  handle('export:capabilities', { roles: ['main'] }, async () => {
    const result = await capability();
    return { mp4Available: result.available, ...(result.reason && { reason: result.reason }) };
  });
  handle('export:mp4', { roles: ['main'] }, (request) => exports.start(request.historyId));
  handle('export:cancel', { roles: ['main'] }, (request) => exports.cancel(request.jobId));
}
