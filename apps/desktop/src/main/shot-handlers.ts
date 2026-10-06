import path from 'node:path';
import fs from 'node:fs';
import { clipboard, ClipboardItem, dialog, nativeImage, shell } from 'electron';
import { MAX_COPY_IMAGE_BYTES, MAX_THUMBNAIL_BYTES } from '../shared/history-ipc';
import type { ProjectFailure, ProjectStore } from './projects/store';
import {
  defaultShotFileName,
  detectImageFormat,
  MAX_FRAME_DIMENSION,
  readImageSize,
  type ShotKind,
  validateImageBytes,
  type ImageFormat,
} from '../shared/shots';
import type { CaptureFlow } from './capture-flow';
import type { HistoryService } from './history/service';
import { validThumbnail } from './history/service';
import type { RecorderController } from './recorder/controller';
import type { SelectionHost } from './selection-host';
import { handle } from './ipc';
import { IpcError } from './ipc-core';
import type { IpcParsedRequest } from '../shared/ipc-contract';
import { log } from './logger';
import { writeFileAtomic } from './shots/atomic-write';
import { freeFileName } from './shots/free-name';
import type { ShotSessionStore } from './shots/session-store';
import type { Settings } from '../shared/settings';
import { rememberExported, wasExported } from './shots/exported-paths';
import { writePngToClipboard } from './shots/after-capture';
import {
  closeGuard,
  getMainWindow,
  onMainWindowClosed,
  setEditorState,
  setQuitting,
} from './windows';

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
export function registerShotHandlers(
  flow: CaptureFlow,
  store: ShotSessionStore,
  recorder: RecorderController,
  history: Pick<HistoryService, 'addScreenshot' | 'get' | 'overwriteScreenshot'>,
  settings: { get(): Settings; screenshotsDir(): string },
  projects?: { store: ProjectStore; appVersion: string },
): void {
  /** A screenshot session of this run. */
  const sessionOf = (id: string) => store.get(id);
  /**
   * Editor sessions opened from a history item (re-edit): session id -> the item it edits. Main-owned,
   * never sent by the renderer.
   */
  const links = new Map<string, string>();
  /** The overlays belong to the recorder (record-region, pick a screen) or to the screenshot flow. */
  const host = (): SelectionHost => (recorder.selecting ? recorder : flow);
  /** The session the editor has open. Its original is deleted when the app window closes. */
  let editorSessionId: string | undefined;
  onMainWindowClosed(() => {
    if (editorSessionId) store.discardSync(editorSessionId);
    editorSessionId = undefined;
    links.clear();
  });

  handle('capture:startScreenshot', { roles: ['main'] }, async (request) => {
    await flow.start(request);
    return { started: true as const };
  });

  handle('shot:get', { roles: ['main'] }, async (request) => {
    const session = sessionOf(request.sessionId);
    const png = session && (await store.readOriginal(session.id));
    if (!session || !png)
      throw new IpcError('NOT_FOUND', 'That screenshot is no longer available.');
    editorSessionId = session.id;
    return { session: store.meta(session), png: toArrayBuffer(png) };
  });

  /**
   * Saves a screenshot of this run: `pickTarget` says where (the Save dialog, or the screenshots
   * folder for a quick save) and returns null when the user cancels. Everything else (validation,
   * history entry) is shared.
   */
  async function exportShot(
    request: IpcParsedRequest<'shot:export'>,
    pickTarget: () => Promise<string | null>,
  ) {
    const session = sessionOf(request.sessionId);
    if (!session) {
      throw new IpcError('NOT_FOUND', 'That screenshot is no longer available.');
    }
    const sourceId = links.get(session.id);
    const bytes = Buffer.from(request.bytes);
    const check = validateImageBytes(request.format, bytes);
    if (!check.ok) throw new IpcError('INVALID_PAYLOAD', check.reason);
    // The history thumbnail comes from the renderer, drawn from the FLATTENED image (redactions
    // applied). Main never derives one from the original capture.
    const thumbnail = request.thumbnail ? new Uint8Array(request.thumbnail) : undefined;
    if (thumbnail && !validThumbnail(thumbnail)) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        `The thumbnail must be a PNG of at most ${MAX_THUMBNAIL_BYTES / 1024 / 1024} MB and 480 px wide.`,
      );
    }

    const picked = await pickTarget();
    if (picked === null) return { cancelled: true as const };
    const target = withExtension(picked, request.format);
    await writeFileAtomic(target, bytes);
    rememberExported(target);
    log.info(`Screenshot exported (${request.format}, ${bytes.byteLength} bytes)`);
    await copyOnSave(bytes, request.format);
    const size = readImageSize(bytes) ?? { width: session.width, height: session.height };
    const original =
      request.project && projects && settings.get().screenshots.keepEditableOriginals
        ? await store.readOriginal(session.id).catch(() => undefined)
        : undefined;
    const added = await history
      .addScreenshot({
        path: target,
        width: size.width,
        height: size.height,
        sizeBytes: bytes.byteLength,
        format: request.format,
        source: session.kind,
        thumbnail,
        ...(sourceId && { derivedFrom: sourceId }),
        ...(original &&
          request.project && {
            project: {
              png: original,
              doc: request.project.doc,
              width: session.width,
              height: session.height,
              appVersion: projects?.appVersion ?? '',
            },
          }),
      })
      .catch((error: unknown) => {
        log.error('The screenshot could not be added to history', error);
        return undefined;
      });
    // "Save as copy" in a re-edit: the session now edits the copy.
    if (sourceId && added) links.set(session.id, added.id);
    return {
      path: target,
      ...(sourceId && added && { historyId: added.id }),
      ...(added && { itemId: added.id }),
    };
  }

  handle('shot:export', { roles: ['main'] }, async (request) => {
    const saved = await exportShot(request, async () => {
      const folder = settings.screenshotsDir();
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
      return result.canceled || !result.filePath ? null : result.filePath;
    });
    if ('cancelled' in saved) return saved;
    return { path: saved.path, ...(saved.historyId && { historyId: saved.historyId }) };
  });

  // Quick save: the same save with no dialog, into the screenshots folder under a free name.
  handle('shot:quickSave', { roles: ['main'] }, async (request) => {
    const saved = await exportShot(request, async () => {
      const folder = settings.screenshotsDir();
      await fs.promises.mkdir(folder, { recursive: true });
      return freeFileName(folder, defaultShotFileName(new Date(), request.format));
    });
    if ('cancelled' in saved) throw new IpcError('INTERNAL', 'The screenshot was not saved.');
    return { path: saved.path, ...(saved.itemId && { historyId: saved.itemId }) };
  });

  /** The "copy to clipboard on save" setting; the clipboard takes PNG (a JPEG is decoded and re-encoded). */
  async function copyOnSave(bytes: Buffer, format: ImageFormat): Promise<void> {
    if (!settings.get().screenshots.copyToClipboardOnSave) return;
    const png =
      format === 'png' ? bytes : nativeImage.createFromBuffer(bytes, { scaleFactor: 1 }).toPNG();
    await writePngToClipboard(png).catch((error: unknown) =>
      log.warn(`Copy on save failed: ${String(error)}`),
    );
  }

  handle('shot:openFromHistory', { roles: ['main'] }, async (request) => {
    const item = history.get(request.historyId);
    if (!item || item.type !== 'screenshot') {
      throw new IpcError('NOT_FOUND', 'That screenshot is not in history.');
    }
    const stat = await fs.promises.stat(item.path).catch(() => null);
    if (!stat?.isFile()) throw new IpcError('NOT_FOUND', 'The file was moved or deleted.');
    if (stat.size > MAX_COPY_IMAGE_BYTES) {
      throw new IpcError('INVALID_PAYLOAD', 'The image is too large to edit.');
    }
    let png: Buffer | undefined;
    let doc: Record<string, unknown> | null = null;
    let notice: string | null = null;
    // The project is looked up by the ITEM's id (never by a stored name), so it is only ever the
    // one that belongs to this item.
    if (item.projectId !== undefined && projects && request.flattened !== true) {
      const project = await projects.store.read(item.id);
      if (project.ok) {
        png = project.png;
        doc = project.doc;
      } else {
        notice = projectNotice(project.reason);
      }
    }
    if (!png) {
      const bytes = await fs.promises.readFile(item.path);
      const format = detectImageFormat(bytes);
      if (format === null) {
        throw new IpcError('INVALID_PAYLOAD', 'The file is not a PNG or JPEG image.');
      }
      png =
        format === 'png' ? bytes : nativeImage.createFromBuffer(bytes, { scaleFactor: 1 }).toPNG();
    }
    const size = readImageSize(png);
    if (!size || size.width > MAX_FRAME_DIMENSION || size.height > MAX_FRAME_DIMENSION) {
      throw new IpcError('INVALID_PAYLOAD', 'The image could not be read.');
    }
    const kind: ShotKind = item.source === 'unknown' ? 'region' : item.source;
    const session = await store.create({ kind, width: size.width, height: size.height, png });
    links.set(session.id, item.id);
    editorSessionId = session.id;
    return {
      session: store.meta(session),
      png: toArrayBuffer(png),
      edit: {
        historyId: item.id,
        format: item.format === 'jpeg' ? ('jpeg' as const) : ('png' as const),
        mode: doc ? ('project' as const) : ('flattened' as const),
        doc,
        notice,
      },
    };
  });

  handle('shot:saveOver', { roles: ['main'] }, async (request) => {
    const session = sessionOf(request.sessionId);
    const sourceId = links.get(request.sessionId);
    if (!session || !sourceId) {
      throw new IpcError('NOT_FOUND', 'That screenshot is no longer available.');
    }
    const item = history.get(sourceId);
    if (!item) throw new IpcError('NOT_FOUND', 'That screenshot is not in history.');
    if (item.format !== request.format) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        `Save it as ${item.format.toUpperCase()} to replace it.`,
      );
    }
    const bytes = Buffer.from(request.bytes);
    const check = validateImageBytes(request.format, bytes);
    if (!check.ok) throw new IpcError('INVALID_PAYLOAD', check.reason);
    const thumbnail = request.thumbnail ? new Uint8Array(request.thumbnail) : undefined;
    if (thumbnail && !validThumbnail(thumbnail)) {
      throw new IpcError('INVALID_PAYLOAD', 'The thumbnail must be a PNG of at most 480 px wide.');
    }
    const size = readImageSize(bytes) ?? { width: session.width, height: session.height };
    // A project is kept when Settings allow it; one that already exists always follows the edit.
    const keepNew = settings.get().screenshots.keepEditableOriginals;
    const wanted =
      request.project && projects && (keepNew || item.projectId !== undefined)
        ? request.project
        : undefined;
    const original =
      wanted && keepNew ? await store.readOriginal(session.id).catch(() => undefined) : undefined;
    const result = await history.overwriteScreenshot(item.id, {
      bytes,
      format: request.format,
      width: size.width,
      height: size.height,
      thumbnail,
      ...(wanted && {
        project: {
          doc: wanted.doc,
          appVersion: projects?.appVersion ?? '',
          ...(original && {
            base: { png: original, width: session.width, height: session.height },
          }),
        },
      }),
    });
    rememberExported(result.path);
    log.info(
      `Screenshot saved over its history item (${request.format}, ${bytes.byteLength} bytes)`,
    );
    await copyOnSave(bytes, request.format);
    return { historyId: item.id, path: result.path, editable: result.editable };
  });

  handle('shot:copy', { roles: ['main'] }, async (request) => {
    if (!sessionOf(request.sessionId)) {
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
    if (editorSessionId === request.sessionId) editorSessionId = undefined;
    links.delete(request.sessionId);
    await store.discard(request.sessionId);
  });

  handle('editor:setDirty', { roles: ['main'] }, (request) => {
    closeGuard.setDirty(request.dirty);
    setEditorState({ open: request.open ?? request.dirty, dirty: request.dirty });
  });
  handle('editor:resolveClose', { roles: ['main'] }, (request) => {
    // "Keep editing" also withdraws a quit that was waiting on this answer.
    if (!request.discard) setQuitting(false);
    if (closeGuard.resolve(request.discard)) getMainWindow()?.close();
  });

  handle('shell:showItemInFolder', { roles: ['main'] }, (request) => {
    const resolved = path.resolve(request.path);
    if (!wasExported(resolved)) {
      throw new IpcError('FORBIDDEN', 'Only files saved by FrameCapt can be shown.');
    }
    shell.showItemInFolder(resolved);
  });

  handle('overlay:getInit', { roles: ['overlay'] }, async (_request, ctx) => {
    const init = await host().overlayInit(ctx.webContentsId);
    if (!init) throw new IpcError('NOT_FOUND', 'No selection is in progress.');
    return init;
  });
  handle('overlay:ready', { roles: ['overlay'] }, (_request, ctx) => {
    host().overlayReady(ctx.webContentsId);
  });
  handle('overlay:selectionStarted', { roles: ['overlay'] }, (_request, ctx) => {
    host().selectionStarted(ctx.webContentsId);
  });
  handle('overlay:confirm', { roles: ['overlay'] }, (request, ctx) =>
    host().confirmRegion(ctx.webContentsId, request.displayId, request.rect),
  );
  handle('overlay:cancel', { roles: ['overlay'] }, () => {
    host().cancel();
  });
  handle('overlay:pickDisplay', { roles: ['overlay'] }, (request, ctx) =>
    host().pickDisplay(ctx.webContentsId, request.displayId),
  );
}

/** What the editor tells the user when the editable data of an item cannot be used. */
function projectNotice(reason: ProjectFailure): string {
  switch (reason) {
    case 'newer_version':
      return 'This screenshot was edited with a newer FrameCapt.';
    case 'missing':
      return 'The editable data of this screenshot is missing.';
    default:
      return 'The editable data of this screenshot is damaged.';
  }
}
