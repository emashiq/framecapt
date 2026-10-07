/**
 * `general.captureFolder` ("Save new captures to"): the settings shape, that only main sets it,
 * that after-capture writes into the (created) folder, and that a rescan finds captures in subfolders.
 */
import { vi } from 'vitest';

vi.mock('electron', () => ({
  clipboard: { write: async () => undefined },
  ClipboardItem: class {},
  nativeImage: {
    createFromBuffer: () => ({
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryService } from '../../src/main/history/service';
import { rescanLibrary } from '../../src/main/history/rescan';
import { listSubfolders } from '../../src/main/library/scan';
import { SettingsStore, SETTINGS_FILE } from '../../src/main/settings/store';
import { createAfterCapture } from '../../src/main/shots/after-capture';
import {
  applyPatch,
  DEFAULT_SETTINGS,
  parseSettings,
  resetSection,
  SettingsPatchSchema,
} from '../../src/shared/settings';
import { defaultShotFileName } from '../../src/shared/shots';
import { fakeTools } from './fake-tools';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-libset-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('captureFolder setting', () => {
  it('defaults to null and an older file without it loads', () => {
    expect(DEFAULT_SETTINGS.general.captureFolder).toBeNull();
    const parsed = parseSettings({ version: 1, general: { theme: 'dark' } });
    expect(parsed.ok && parsed.settings.general.captureFolder).toBeNull();
  });

  it('a stored value must be a valid relative folder', () => {
    const ok = parseSettings({ version: 1, general: { captureFolder: 'Clients/Acme' } });
    expect(ok.ok && ok.settings.general.captureFolder).toBe('Clients/Acme');
    for (const bad of ['..', 'C:/x', 'a//b', '/abs', 'CON']) {
      expect(parseSettings({ version: 1, general: { captureFolder: bad } }).ok, bad).toBe(false);
    }
  });

  it('is not part of the renderer settings patch (only library:setCaptureFolder sets it)', () => {
    expect(SettingsPatchSchema.safeParse({ general: { captureFolder: 'A' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ general: { theme: 'dark' } }).success).toBe(true);
  });

  it('survives a general reset and a patch', () => {
    const current = structuredClone(DEFAULT_SETTINGS);
    current.general.captureFolder = 'Clients';
    expect(resetSection(current, 'general').general.captureFolder).toBe('Clients');
    expect(applyPatch(current, { general: { theme: 'dark' } }).general.captureFolder).toBe(
      'Clients',
    );
  });

  it('the store sets it, persists it and notifies', async () => {
    const file = path.join(dir, SETTINGS_FILE);
    const store = new SettingsStore(file, { debounceMs: 0 });
    let seen: string | null = null;
    store.onChange((settings) => {
      seen = settings.general.captureFolder;
    });
    store.setCaptureFolder('Clients/Acme');
    expect(seen).toBe('Clients/Acme');
    await store.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).general.captureFolder).toBe('Clients/Acme');
    store.setCaptureFolder(null);
    expect(store.get().general.captureFolder).toBeNull();
  });
});

describe('saving into the folder', () => {
  it('after-capture creates the folder and saves there', async () => {
    const target = path.join(dir, 'Pictures', 'Clients', 'Acme');
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.screenshots.afterCapture = 'save-and-editor';
    const added: string[] = [];
    const afterCapture = createAfterCapture({
      settings: () => settings,
      screenshotsDir: () => target,
      history: {
        addScreenshot: async (input) => {
          added.push(input.path);
          return { id: 'x' };
        },
      },
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { savedPath } = await afterCapture({ kind: 'region', width: 10, height: 10, png });
    expect(path.dirname(savedPath ?? '')).toBe(target);
    expect(added).toEqual([savedPath]);
  });
});

function fakePng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('rescan of the library folders', () => {
  const at = (second: number): Date => new Date(2026, 9, 2, 14, 5, second);

  it('finds captures in nested folders (8 levels), not in hidden folders or links', async () => {
    const shots = path.join(dir, 'shots');
    const videos = path.join(dir, 'videos');
    fs.mkdirSync(shots);
    fs.mkdirSync(videos);
    const deep = path.join(shots, ...'abcdefgh'.split(''));
    const tooDeep = path.join(deep, 'i');
    for (const folder of [
      deep,
      tooDeep,
      path.join(shots, '.hidden'),
      path.join(shots, 'Clients'),
    ]) {
      fs.mkdirSync(folder, { recursive: true });
    }
    fs.writeFileSync(
      path.join(shots, 'Clients', defaultShotFileName(at(1), 'png')),
      fakePng(10, 10),
    );
    fs.writeFileSync(path.join(deep, defaultShotFileName(at(2), 'png')), fakePng(10, 10));
    fs.writeFileSync(path.join(tooDeep, defaultShotFileName(at(3), 'png')), fakePng(10, 10));
    fs.writeFileSync(
      path.join(shots, '.hidden', defaultShotFileName(at(4), 'png')),
      fakePng(10, 10),
    );
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, defaultShotFileName(at(5), 'png')), fakePng(10, 10));
    try {
      fs.symlinkSync(outside, path.join(shots, 'Link'), 'junction');
    } catch {
      /* links not permitted here */
    }

    const tools = fakeTools();
    const history = new HistoryService({
      dir: path.join(dir, 'history'),
      tools,
      trashItem: () => Promise.resolve(),
    });
    const added = await rescanLibrary({
      dirs: [shots, videos],
      history,
      tools,
      thumbnail: () => Promise.resolve(undefined),
    });
    expect(added).toBe(2);
    const paths = history.items().map((item) => item.path);
    expect(paths).toContain(path.join(shots, 'Clients', defaultShotFileName(at(1), 'png')));
    expect(paths).toContain(path.join(deep, defaultShotFileName(at(2), 'png')));
  });

  it('lists subfolders parents first, without links, hidden, system or guide folders', async () => {
    for (const folder of [
      'A/B',
      '.git/x',
      '$RECYCLE.BIN',
      'FrameCapt Steps 2026-10-02 at 14.05.01',
    ]) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
    }
    expect((await listSubfolders(dir)).sort()).toEqual(['A', 'A/B']);
  });
});
