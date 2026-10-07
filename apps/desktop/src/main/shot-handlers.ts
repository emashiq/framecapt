import path from 'node:path';
import fs from 'node:fs';
import { clipboard, ClipboardItem, dialog, nativeImage, shell } from 'electron';
import { MAX_COPY_IMAGE_BYTES, MAX_THUMBNAIL_BYTES } from '../shared/history-ipc';
import type { ProjectFailure, ProjectStore } from './projects/store';
import {
  defaultShotFileName,
  detectImageFormat,
  isImportableImage,
  MAX_FRAME_DIMENSION,
  MAX_FRAME_PNG_BYTES,
  MAX_IMPORT_BYTES,
  readImageSize,
  type ShotKind,
  validateImageBytes,
  type ImageFormat,
} from '../shared/shots';
import type { CaptureFlow } from './capture-flow';
import type { FlowService } from './flows/service';
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
import { dialogParent, onMainWindowClosed } from './windows';

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

const IMAGE_OPEN_FILTERS: Electron.FileFilter[] = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
];

/** A PNG for a PNG or JPEG file (a JPEG is decoded and re-encoded). Throws for anything else. */
function pngOf(bytes: Buffer): Buffer {
  const format = detectImageFormat(bytes);
  if (format === null)
    throw new IpcError('INVALID_PAYLOAD', 'The file is not a PNG or JPEG image.');
  return format === 'png' ? bytes : nativeImage.createFromBuffer(bytes, { scaleFactor: 1 }).toPNG();
}

/** The size of a PNG whose sides are within the frame limit, or throws. */
function checkedSize(png: Buffer): { width: number; height: number } {
  const size = readImageSize(png);
  if (!size || size.width > MAX_FRAME_DIMENSION || size.height > MAX_FRAME_DIMENSION) {
    throw new IpcError('INVALID_PAYLOAD', 'The image could not be read.');
  }
  return size;
}

/** The image-layer pictures of a project payload as buffers (the store verifies their hashes). */
function assetsOf(project: { assets?: { id: string; png: ArrayBuffer }[] | undefined }) {
  return (project.assets ?? []).map((asset) => ({ id: asset.id, png: Buffer.from(asset.png) }));
}

/**
 * Shows the Open dialog for a picture and returns its bytes, checked for size and magic bytes (the
 * extension is not trusted). The path never leaves main; the renderer decodes the picture.
 */
async function pickImage(title: string) {
  const options: Electron.OpenDialogOptions = {
    title,
    filters: IMAGE_OPEN_FILTERS,
    properties: ['openFile'],
  };
  const parent = dialogParent();
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  if (result.canceled || !file) return { cancelled: true as const };
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new IpcError('NOT_FOUND', 'The file could not be opened.');
  if (stat.size > MAX_IMPORT_BYTES)
    throw new IpcError('INVALID_PAYLOAD', 'The image is too large.');
  const bytes = await fs.promises.readFile(file);
  if (!isImportableImage(bytes)) {
    throw new IpcError('INVALID_PAYLOAD', 'The file is not a PNG, JPEG, WebP, GIF or BMP image.');
  }
  return { name: path.basename(file), bytes: toArrayBuffer(bytes) };
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
  settings: {
    get(): Settings;
    screenshotsDir(): string;
    /** The auto-copy rule (`AutoCopy.screenshot`): copies the PNG when the setting is on. */
    copyImage(png: Uint8Array, options?: { quiet?: boolean }): Promise<boolean>;
  },
  projects?: { store: ProjectStore; appVersion: string },
  flows?: Pick<FlowService, 'readStep' | 'replaceStep'>,
): void {
  /** A screenshot session of this run. */
  const sessionOf = (id: string) => store.get(id);
  /**
   * Editor sessions opened from a history item (re-edit): session id -> the item it edits. Main-owned,
   * never sent by the renderer.
   */
  const links = new Map<string, string>();
  /** Editor sessions opened on one step of a step guide: session id -> the guide and the step. Main-owned. */
  const stepLinks = new Map<string, { historyId: string; index: number }>();
  /** The overlays belong to the recorder (record-region, pick a screen) or to the screenshot flow. */
  const host = (): SelectionHost => (recorder.selecting ? recorder : flow);
  /** The sessions the editor tabs have open. Their originals are deleted when the main window closes. */
  const editorSessions = new Set<string>();
  onMainWindowClosed(() => {
    for (const id of editorSessions) store.discardSync(id);
    editorSessions.clear();
    links.clear();
    stepLinks.clear();
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
    editorSessions.add(session.id);
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
        source: session.kind === 'import' ? 'unknown' : session.kind,
        thumbnail,
        ...(sourceId && { derivedFrom: sourceId }),
        ...(original &&
          request.project && {
            project: {
              png: original,
              doc: request.project.doc,
              assets: assetsOf(request.project),
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
      const parent = dialogParent();
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
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

  /**
   * The auto-copy rule after an edit is saved: the exported bytes (flattened, redactions in the
   * pixels), never the unredacted original. The clipboard takes PNG (a JPEG is decoded and
   * re-encoded). The editor says "Saved" itself, so this one is quiet.
   */
  async function copyOnSave(bytes: Buffer, format: ImageFormat): Promise<void> {
    if (!settings.get().screenshots.autoCopy) return;
    const png =
      format === 'png' ? bytes : nativeImage.createFromBuffer(bytes, { scaleFactor: 1 }).toPNG();
    await settings.copyImage(png, { quiet: true });
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
    let assets: { id: string; png: ArrayBuffer }[] = [];
    // The project is looked up by the ITEM's id (never by a stored name), so it is only ever the
    // one that belongs to this item.
    if (item.projectId !== undefined && projects && request.flattened !== true) {
      const project = await projects.store.read(item.id);
      if (project.ok) {
        png = project.png;
        doc = project.doc;
        assets = project.assets.map((asset) => ({ id: asset.id, png: toArrayBuffer(asset.png) }));
      } else {
        notice = projectNotice(project.reason);
      }
    }
    png ??= pngOf(await fs.promises.readFile(item.path));
    const size = checkedSize(png);
    // A screenshot is never a multi-source item; anything not a plain capture opens as an import.
    const kind: ShotKind =
      item.source === 'unknown' || item.source === 'multi' ? 'import' : item.source;
    const session = await store.create({ kind, width: size.width, height: size.height, png });
    links.set(session.id, item.id);
    editorSessions.add(session.id);
    return {
      session: store.meta(session),
      png: toArrayBuffer(png),
      edit: {
        historyId: item.id,
        format: item.format === 'jpeg' ? ('jpeg' as const) : ('png' as const),
        mode: doc ? ('project' as const) : ('flattened' as const),
        doc,
        notice,
        assets,
      },
    };
  });

  // One step of a step guide in the editor: Save writes the edited picture over that step's image.
  handle('flow:openStepInEditor', { roles: ['main'] }, async (request) => {
    if (!flows) throw new IpcError('INTERNAL', 'Step guides are not available.');
    const step = await flows.readStep(request.historyId, request.index);
    const session = await store.create({
      kind: 'screen',
      width: step.width,
      height: step.height,
      png: step.png,
    });
    stepLinks.set(session.id, { historyId: request.historyId, index: request.index });
    editorSessions.add(session.id);
    return {
      session: store.meta(session),
      png: toArrayBuffer(step.png),
      edit: {
        historyId: request.historyId,
        format: 'png' as const,
        mode: 'flattened' as const,
        doc: null,
        notice: null,
        assets: [],
      },
    };
  });

  handle('shot:openImage', { roles: ['main'] }, () => pickImage('Open image'));
  handle('editor:pickImage', { roles: ['main'] }, () => pickImage('Insert image'));

  // A picture the user opened, dropped or pasted, already decoded and re-encoded as PNG by the
  // renderer: validated again here, then an editor session of its own. It is NOT saved anywhere
  // (the after-capture settings are for captures only).
  handle('shot:importImage', { roles: ['main'] }, async (request) => {
    const png = Buffer.from(request.png);
    const check = validateImageBytes('png', png, MAX_FRAME_PNG_BYTES);
    if (!check.ok) throw new IpcError('INVALID_PAYLOAD', check.reason);
    const size = checkedSize(png);
    const session = await store.create({ kind: 'import', ...size, png });
    editorSessions.add(session.id);
    return { session: store.meta(session) };
  });

  handle('editor:historyImage', { roles: ['main'] }, async (request) => {
    const item = history.get(request.historyId);
    if (!item || item.type !== 'screenshot') {
      throw new IpcError('NOT_FOUND', 'That screenshot is not in history.');
    }
    const stat = await fs.promises.stat(item.path).catch(() => null);
    if (!stat?.isFile()) throw new IpcError('NOT_FOUND', 'The file was moved or deleted.');
    if (stat.size > MAX_IMPORT_BYTES)
      throw new IpcError('INVALID_PAYLOAD', 'The image is too large.');
    const png = pngOf(await fs.promises.readFile(item.path));
    checkedSize(png);
    return { png: toArrayBuffer(png) };
  });

  handle('shot:saveOver', { roles: ['main'] }, async (request) => {
    const session = sessionOf(request.sessionId);
    const stepLink = stepLinks.get(request.sessionId);
    if (session && stepLink && flows) {
      if (request.format !== 'png') {
        throw new IpcError('INVALID_PAYLOAD', 'A step of a guide is saved as PNG.');
      }
      const saved = await flows.replaceStep(
        stepLink.historyId,
        stepLink.index,
        new Uint8Array(request.bytes),
      );
      rememberExported(saved.path);
      return { historyId: stepLink.historyId, path: saved.path, editable: false };
    }
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
          assets: assetsOf(wanted),
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
    editorSessions.delete(request.sessionId);
    links.delete(request.sessionId);
    stepLinks.delete(request.sessionId);
    await store.discard(request.sessionId);
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
