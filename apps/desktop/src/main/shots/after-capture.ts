import fs from 'node:fs';
import { clipboard, ClipboardItem, nativeImage } from 'electron';
import { MAX_THUMBNAIL_WIDTH } from '../../shared/history-ipc';
import { defaultShotFileName, type CaptureTarget } from '../../shared/shots';
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
  /** The auto-copy rule (`AutoCopy.screenshot`): copies the PNG when the setting is on; true when it did. */
  copyImage: (png: Uint8Array, options?: { quiet?: boolean }) => Promise<boolean>;
}

type Shot = { kind: CaptureTarget; width: number; height: number; png: Buffer };

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
 * Before the editor opens: the capture goes to the clipboard (the auto-copy setting; no toast, the
 * editor opening is the feedback), and the "after a capture" setting may also save it to the
 * screenshots folder (and list it in history). Returns the saved path when it saved. A failure is
 * logged and never stops the editor from opening: the capture is still in its session.
 */
export function createAfterCapture(deps: AfterCaptureDeps) {
  return async (shot: Shot): Promise<{ savedPath?: string }> => {
    await deps.copyImage(shot.png, { quiet: true });
    if (deps.settings().screenshots.afterCapture === 'editor') return {};
    try {
      return { savedPath: await saveToFolder(deps, shot) };
    } catch (error) {
      log.warn(`Saving after capture failed: ${String(error)}`);
      return {};
    }
  };
}

/**
 * A capture with no editor to open (a screenshot taken while recording, or All screens): always
 * saved to the screenshots folder and listed in history, and copied when auto-copy is on (`copied`
 * lets the caller say "saved and copied" in one toast). Throws when it could not be saved.
 */
export function createSaveCaptureDirect(deps: AfterCaptureDeps) {
  return async (shot: Shot): Promise<{ savedPath: string; copied: boolean }> => {
    const copied = await deps.copyImage(shot.png, { quiet: true });
    return { savedPath: await saveToFolder(deps, shot), copied };
  };
}
