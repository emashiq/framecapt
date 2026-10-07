/**
 * Capturing: the auto-copy rule (one rule for every path) and saving a capture with no editor (a
 * screenshot taken during a recording): always a file in the screenshots folder plus a history
 * entry, in the configured format, copied too when auto-copy is on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  clipboard: {},
  ClipboardItem: class {},
  nativeImage: {
    createFromBuffer: () => ({
      toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0x01]),
      toPNG: () => Buffer.from('thumb'),
      resize: () => ({ toPNG: () => Buffer.from('small') }),
    }),
  },
}));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAfterCapture, createSaveCaptureDirect } from '../../src/main/shots/after-capture';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const shot = { kind: 'region' as const, width: 800, height: 600, png: PNG };

let folder: string;
const copied: { png: Uint8Array; quiet: boolean | undefined }[] = [];
beforeEach(() => {
  copied.length = 0;
  folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-direct-')), 'shots');
});

function setup(change: (settings: Settings) => void = () => undefined) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  change(settings);
  const addScreenshot = vi.fn(async () => ({ id: 'h1' }));
  // The real rule lives in AutoCopy (clipboard.test.ts); here it is a spy that follows the setting.
  const deps = {
    settings: () => settings,
    screenshotsDir: () => folder,
    history: { addScreenshot },
    copyImage: async (png: Uint8Array, options?: { quiet?: boolean }) => {
      if (!settings.screenshots.autoCopy) return false;
      copied.push({ png, quiet: options?.quiet });
      return true;
    },
  };
  return { save: createSaveCaptureDirect(deps), after: createAfterCapture(deps), addScreenshot };
}

describe('saving a capture directly', () => {
  it('writes a PNG to the screenshots folder and lists it in history, even when the setting opens the editor', async () => {
    const { save, addScreenshot } = setup();
    const { savedPath } = await save(shot);
    expect(path.dirname(savedPath)).toBe(folder);
    expect(path.extname(savedPath)).toBe('.png');
    expect(fs.readFileSync(savedPath)).toEqual(PNG);
    expect(addScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        path: savedPath,
        width: 800,
        height: 600,
        format: 'png',
        source: 'region',
        sizeBytes: PNG.byteLength,
        thumbnail: expect.anything(),
      }),
    );
  });

  it('follows the JPEG format setting', async () => {
    const { save, addScreenshot } = setup((settings) => {
      settings.screenshots.format = 'jpeg';
    });
    const { savedPath } = await save(shot);
    expect(path.extname(savedPath)).toBe('.jpg');
    expect(fs.readFileSync(savedPath)[0]).toBe(0xff);
    expect(addScreenshot).toHaveBeenCalledWith(expect.objectContaining({ format: 'jpeg' }));
  });

  it('also copies the image when auto-copy is on, and says so for the toast', async () => {
    const { save } = setup();
    const result = await save(shot);
    expect(result.copied).toBe(true);
    expect(copied).toHaveLength(1);
    expect(copied[0]?.png).toEqual(PNG);
  });

  it('does not copy when auto-copy is off', async () => {
    const { save } = setup((settings) => {
      settings.screenshots.autoCopy = false;
    });
    const result = await save(shot);
    expect(result.copied).toBe(false);
    expect(copied).toHaveLength(0);
  });

  it('the capture is copied before the editor opens, whatever the after-capture mode (one rule)', async () => {
    for (const mode of ['editor', 'save-and-editor'] as const) {
      copied.length = 0;
      const { after } = setup((settings) => {
        settings.screenshots.afterCapture = mode;
      });
      const result = await after(shot);
      expect(copied).toHaveLength(1);
      expect(copied[0]?.quiet).toBe(true);
      expect(result.savedPath !== undefined).toBe(mode === 'save-and-editor');
    }
  });

  it('never overwrites an existing file', async () => {
    const { save } = setup();
    const first = await save(shot);
    const second = await save(shot);
    expect(second.savedPath).not.toBe(first.savedPath);
  });

  it('throws when the file cannot be written', async () => {
    const { save } = setup();
    fs.mkdirSync(path.dirname(folder), { recursive: true });
    fs.writeFileSync(folder, 'a file where the folder should be');
    await expect(save(shot)).rejects.toThrow();
  });
});
