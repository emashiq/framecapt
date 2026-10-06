/**
 * Saving a capture with no editor (a screenshot taken during a recording): always a file in the
 * screenshots folder plus a history entry, in the configured format, copied too when asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ copied: [] as unknown[] }));
vi.mock('electron', () => ({
  clipboard: {
    write: async (items: unknown[]) => {
      hoisted.copied.push(...items);
    },
  },
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
import { createSaveCaptureDirect } from '../../src/main/shots/after-capture';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const shot = { kind: 'region' as const, width: 800, height: 600, png: PNG };

let folder: string;
beforeEach(() => {
  hoisted.copied.length = 0;
  folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-direct-')), 'shots');
});

function setup(change: (settings: Settings) => void = () => undefined) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  change(settings);
  const addScreenshot = vi.fn(async () => ({ id: 'h1' }));
  const save = createSaveCaptureDirect({
    settings: () => settings,
    screenshotsDir: () => folder,
    history: { addScreenshot },
  });
  return { save, addScreenshot };
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
    expect(hoisted.copied).toHaveLength(0);
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

  it('also copies the image when the setting asks for a copy', async () => {
    const { save } = setup((settings) => {
      settings.screenshots.afterCapture = 'copy-and-editor';
    });
    await save(shot);
    expect(hoisted.copied).toHaveLength(1);
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
