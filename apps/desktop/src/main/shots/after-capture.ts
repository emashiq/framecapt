import fs from 'node:fs';
import { clipboard, ClipboardItem, nativeImage } from 'electron';
import { MAX_THUMBNAIL_WIDTH } from '../../shared/history-ipc';
import { defaultShotFileName, type ShotKind } from '../../shared/shots';
import type { Settings } from '../../shared/settings';
import type { HistoryService } from '../history/service';
import { log } from '../logger';
import { writeFileAtomic } from './atomic-write';
import { rememberExported } from './exported-paths';
import { freeFileName } from './free-name';

/** PNG bytes onto the clipboard as an image (Electron 44: the promise-based W3C clipboard). */
export async function writePngToClipboard(png: Uint8Array): Promise<void> {
  await clipboard.write([
    new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
  ]);
}

export interface AfterCaptureDeps {
  settings: () => Settings;
  screenshotsDir: () => string;
  history: Pick<HistoryService, 'addScreenshot'>;
}

type Shot = { kind: ShotKind; width: number; height: number; png: Buffer };

/**
 * Writes the capture to the screenshots folder in the configured format and lists it in history.
 * Throws when the file could not be written (a history failure is only logged).
 */
async function saveToFolder(deps: AfterCaptureDeps, shot: Shot): Promise<string> {
  const { format, jpegQuality } = deps.settings().screenshots;
  const folder = deps.screenshotsDir();
  await fs.promises.mkdir(folder, { recursive: true });
  const bytes =
    format === 'png'
      ? shot.png
      : nativeImage
          .createFromBuffer(shot.png, { scaleFactor: 1 })
          .toJPEG(Math.round(jpegQuality * 100));
  const target = await freeFileName(folder, defaultShotFileName(new Date(), format));
  await writeFileAtomic(target, bytes);
  rememberExported(target);
  // The capture is still unedited, so a thumbnail of it is the thumbnail of the saved file.
  const image = nativeImage.createFromBuffer(shot.png, { scaleFactor: 1 });
  const thumbnail =
    shot.width > MAX_THUMBNAIL_WIDTH
      ? image.resize({ width: MAX_THUMBNAIL_WIDTH, quality: 'best' })
      : image;
  await deps.history
    .addScreenshot({
      path: target,
      width: shot.width,
      height: shot.height,
      sizeBytes: bytes.byteLength,
      format,
      source: shot.kind,
      thumbnail: thumbnail.toPNG(),
    })
    .catch((error: unknown) => log.error('The screenshot could not be added to history', error));
  log.info(`Screenshot saved (${format}, ${bytes.byteLength} bytes)`);
  return target;
}

/**
 * What the "after a capture" setting asks for, before the editor opens: copy the image, or save it
 * to the screenshots folder (and list it in history). Returns the saved path when it saved. A
 * failure is logged and never stops the editor from opening: the capture is still in its session.
 */
export function createAfterCapture(deps: AfterCaptureDeps) {
  return async (shot: Shot): Promise<{ savedPath?: string }> => {
    const { afterCapture } = deps.settings().screenshots;
    if (afterCapture === 'editor') return {};
    if (afterCapture === 'copy-and-editor') {
      await writePngToClipboard(shot.png).catch((error: unknown) =>
        log.warn(`Copy after capture failed: ${String(error)}`),
      );
      return {};
    }
    try {
      return { savedPath: await saveToFolder(deps, shot) };
    } catch (error) {
      log.warn(`Saving after capture failed: ${String(error)}`);
      return {};
    }
  };
}

/**
 * A capture with no editor to open (a screenshot taken while recording): always saved to the
 * screenshots folder and listed in history, and also copied when the setting asks for a copy.
 * Throws when it could not be saved.
 */
export function createSaveCaptureDirect(deps: AfterCaptureDeps) {
  return async (shot: Shot): Promise<{ savedPath: string }> => {
    if (deps.settings().screenshots.afterCapture === 'copy-and-editor') {
      await writePngToClipboard(shot.png).catch((error: unknown) =>
        log.warn(`Copy after capture failed: ${String(error)}`),
      );
    }
    return { savedPath: await saveToFolder(deps, shot) };
  };
}
