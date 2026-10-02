import path from 'node:path';
import fs from 'node:fs';
import { app, clipboard, ClipboardItem, dialog, nativeImage, shell } from 'electron';
import { defaultShotFileName, validateImageBytes, type ImageFormat } from '../shared/shots';
import type { CaptureFlow } from './capture-flow';
import { handle } from './ipc';
import { IpcError } from './ipc-core';
import { log } from './logger';
import { writeFileAtomic } from './shots/atomic-write';
import type { ShotSessionStore } from './shots/session-store';
import { getMainWindow } from './windows';

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function dialogFilters(format: ImageFormat): Electron.FileFilter[] {
  return format === 'png'
    ? [{ name: 'PNG image', extensions: ['png'] }]
    : [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }];
}

/** Adds the format's extension when the user typed a name without a matching one. */
function withExtension(file: string, format: ImageFormat): string {
  const ext = path.extname(file).toLowerCase();
  const ok = format === 'png' ? ext === '.png' : ext === '.jpg' || ext === '.jpeg';
  return ok ? file : `${file}.${format === 'png' ? 'png' : 'jpg'}`;
}

/**
 * Screenshot-session, export and overlay channels. Paths are always main-owned: originals live in
 * the shots directory, exports go where the user picks in a main-process save dialog, and
 * "show in folder" only accepts paths this run exported.
 */
export function registerShotHandlers(flow: CaptureFlow, store: ShotSessionStore): void {
  /** Paths written by `shot:export` in this run; the only ones `shell:showItemInFolder` accepts. */
  const exportedPaths = new Set<string>();

  handle('capture:startScreenshot', { roles: ['main'] }, async (request) => {
    await flow.start(request);
    return { started: true as const };
  });

  handle('shot:get', { roles: ['main'] }, async (request) => {
    const session = store.get(request.sessionId);
    const png = session && (await store.readOriginal(session.id));
    if (!session || !png)
      throw new IpcError('NOT_FOUND', 'That screenshot is no longer available.');
    return { session: store.meta(session), png: toArrayBuffer(png) };
  });

  handle('shot:export', { roles: ['main'] }, async (request) => {
    if (!store.get(request.sessionId)) {
      throw new IpcError('NOT_FOUND', 'That screenshot is no longer available.');
    }
    const bytes = Buffer.from(request.bytes);
    const check = validateImageBytes(request.format, bytes);
    if (!check.ok) throw new IpcError('INVALID_PAYLOAD', check.reason);

    const folder = path.join(app.getPath('pictures'), 'Framelet');
    await fs.promises.mkdir(folder, { recursive: true });
    const options: Electron.SaveDialogOptions = {
      title: 'Save screenshot',
      defaultPath: path.join(folder, defaultShotFileName(new Date(), request.format)),
      filters: dialogFilters(request.format),
      properties: ['showOverwriteConfirmation'],
    };
    const main = getMainWindow();
    const result = main
      ? await dialog.showSaveDialog(main, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { cancelled: true as const };

    const target = withExtension(result.filePath, request.format);
    await writeFileAtomic(target, bytes);
    exportedPaths.add(path.resolve(target));
    log.info(`Screenshot exported (${request.format}, ${bytes.byteLength} bytes)`);
    return { path: target };
  });

  handle('shot:copy', { roles: ['main'] }, async (request) => {
    if (!store.get(request.sessionId)) {
      throw new IpcError('NOT_FOUND', 'That screenshot is no longer available.');
    }
    const bytes = Buffer.from(request.bytes);
    const check = validateImageBytes('png', bytes);
    if (!check.ok) throw new IpcError('INVALID_PAYLOAD', check.reason);
    const image = nativeImage.createFromBuffer(bytes, { scaleFactor: 1 });
    if (image.isEmpty()) throw new IpcError('INVALID_PAYLOAD', 'The image could not be read.');
    // Electron 44's clipboard module is the promise-based W3C API (there is no writeImage).
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
    ]);
  });

  handle('shot:discard', { roles: ['main'] }, async (request) => {
    await store.discard(request.sessionId);
  });

  handle('shell:showItemInFolder', { roles: ['main'] }, (request) => {
    const resolved = path.resolve(request.path);
    if (!exportedPaths.has(resolved)) {
      throw new IpcError('FORBIDDEN', 'Only files saved by Framelet can be shown.');
    }
    shell.showItemInFolder(resolved);
  });

  handle('overlay:getInit', { roles: ['overlay'] }, (_request, ctx) => {
    const init = flow.overlayInit(ctx.webContentsId);
    if (!init) throw new IpcError('NOT_FOUND', 'No selection is in progress.');
    return init;
  });
  handle('overlay:ready', { roles: ['overlay'] }, (_request, ctx) => {
    flow.overlayReady(ctx.webContentsId);
  });
  handle('overlay:selectionStarted', { roles: ['overlay'] }, (_request, ctx) => {
    flow.selectionStarted(ctx.webContentsId);
  });
  handle('overlay:confirm', { roles: ['overlay'] }, (request, ctx) =>
    flow.confirmRegion(ctx.webContentsId, request.displayId, request.rect),
  );
  handle('overlay:cancel', { roles: ['overlay'] }, () => {
    flow.cancel();
  });
  handle('overlay:pickDisplay', { roles: ['overlay'] }, (request, ctx) =>
    flow.pickDisplay(ctx.webContentsId, request.displayId),
  );
}
