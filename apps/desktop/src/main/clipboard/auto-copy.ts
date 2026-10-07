import type { Settings } from '../../shared/settings';
import { log } from '../logger';
import { writePngToClipboard } from '../shots/after-capture';
import { clipboardHoldsFiles, writeFilesToClipboard } from './files';

export interface AutoCopyDeps {
  settings: () => Settings;
  /** A small "Copied to clipboard" message (toolbar toast while recording, else the main window or the OS). */
  notify: (message: string) => void;
  /** Replaceable in tests. */
  writeImage?: (png: Uint8Array) => Promise<void>;
  writeFiles?: (files: readonly string[]) => Promise<void>;
  holdsFiles?: (files: readonly string[]) => Promise<boolean>;
}

/**
 * The one clipboard rule (Settings: "Copy every screenshot / recording to the clipboard"): a
 * screenshot goes on as a PNG, a recording, an exported video or a step guide's folder as a file.
 * Every method is a no-op when its setting is off and never throws: a clipboard that is locked by
 * another program must not fail a capture.
 */
export class AutoCopy {
  private readonly writeImage: (png: Uint8Array) => Promise<void>;
  private readonly writeFiles: (files: readonly string[]) => Promise<void>;
  private readonly holdsFiles: (files: readonly string[]) => Promise<boolean>;

  constructor(private readonly deps: AutoCopyDeps) {
    this.writeImage = deps.writeImage ?? writePngToClipboard;
    this.writeFiles = deps.writeFiles ?? writeFilesToClipboard;
    this.holdsFiles = deps.holdsFiles ?? clipboardHoldsFiles;
  }

  /** The image of a capture (PNG bytes). True when it was copied. `quiet`: the caller says it itself. */
  async screenshot(png: Uint8Array, options: { quiet?: boolean } = {}): Promise<boolean> {
    if (!this.deps.settings().screenshots.autoCopy) return false;
    try {
      await this.writeImage(png);
    } catch (error) {
      log.warn(`Copy to the clipboard failed: ${String(error)}`);
      return false;
    }
    if (!options.quiet) this.deps.notify('Copied to clipboard');
    return true;
  }

  /** A saved recording, an exported video or a guide folder, as a file on the clipboard. */
  async file(file: string, options: { quiet?: boolean } = {}): Promise<boolean> {
    if (!this.deps.settings().recording.autoCopy) return false;
    try {
      await this.writeFiles([file]);
    } catch (error) {
      log.warn(`Copy to the clipboard failed: ${String(error)}`);
      return false;
    }
    if (!options.quiet) this.deps.notify('Copied to clipboard');
    return true;
  }

  /**
   * A recording's file was replaced by its converted version: put the new file on the clipboard,
   * but only if the clipboard still holds the old one (the user may have copied something else).
   */
  async replaced(change: { from: string; to: string }): Promise<void> {
    if (!this.deps.settings().recording.autoCopy) return;
    if (!(await this.holdsFiles([change.from]))) return;
    await this.file(change.to, { quiet: true });
  }
}
