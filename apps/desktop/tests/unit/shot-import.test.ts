/**
 * Opening and importing pictures: `shot:openImage` (dialog, magic bytes, size cap), `shot:importImage`
 * (a PNG made by the renderer starts a session that is never auto-saved), `editor:pickImage` and
 * `editor:historyImage` (image layers), and the pictures of image layers travelling with a project.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (request: unknown, ctx: { webContentsId: number; role: string }) => unknown
  >(),
  open: { canceled: false, filePaths: [] as string[] },
  save: { value: '' },
}));
vi.mock('electron', () => ({
  clipboard: {},
  ClipboardItem: class {},
  dialog: {
    showOpenDialog: async () => hoisted.open,
    showSaveDialog: async () => ({ canceled: false, filePath: hoisted.save.value }),
  },
  nativeImage: {},
  shell: {},
}));
vi.mock('../../src/main/ipc', () => ({
  handle: (
    channel: string,
    _options: unknown,
    handler: (request: unknown, ctx: { webContentsId: number; role: string }) => unknown,
  ) => hoisted.handlers.set(channel, handler),
}));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock('../../src/main/windows', () => ({
  dialogParent: () => undefined,
  onEditorWindowClosed: () => undefined,
}));
vi.mock('../../src/main/shots/after-capture', () => ({
  writePngToClipboard: async () => undefined,
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerShotHandlers } from '../../src/main/shot-handlers';
import { HistoryService } from '../../src/main/history/service';
import { ProjectStore } from '../../src/main/projects/store';
import { ShotSessionStore } from '../../src/main/shots/session-store';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';
import { MAX_FRAME_DIMENSION } from '../../src/shared/shots';
import { fakeTools } from './fake-tools';
import { pngBytes, SAMPLE_DOC } from './project-fixtures';

const ctx = { webContentsId: 1, role: 'main' };
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

let root: string;
beforeEach(() => {
  hoisted.handlers.clear();
  hoisted.open = { canceled: false, filePaths: [] };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-import-'));
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
});

async function setup() {
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const store = new ShotSessionStore(path.join(root, 'shots'));
  const projects = new ProjectStore(path.join(root, 'projects'));
  const history = new HistoryService({
    dir: path.join(root, 'history'),
    projects,
    tools: fakeTools(),
    trashItem: async (file) => fs.rmSync(file),
  });
  registerShotHandlers(
    {} as never,
    store,
    { selecting: false } as never,
    history,
    {
      get: () => settings,
      screenshotsDir: () => path.join(root, 'out'),
      copyImage: async () => false,
    },
    { store: projects, appVersion: '1.0.0' },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (channel: string, request?: unknown): Promise<any> =>
    Promise.resolve(hoisted.handlers.get(channel)?.(request, ctx));
  return { call, store, projects, history };
}

function pickFile(name: string, bytes: Buffer): void {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  hoisted.open = { canceled: false, filePaths: [file] };
}

describe('shot:openImage and editor:pickImage', () => {
  it('answer cancelled when the dialog is cancelled', async () => {
    const s = await setup();
    hoisted.open = { canceled: true, filePaths: [] };
    expect(await s.call('shot:openImage')).toEqual({ cancelled: true });
    expect(await s.call('editor:pickImage')).toEqual({ cancelled: true });
  });

  it('return the picked picture by name and bytes, never its path', async () => {
    const s = await setup();
    const png = pngBytes(8, 6);
    pickFile('photo.png', png);
    const picked = await s.call('shot:openImage');
    expect(Object.keys(picked).sort()).toEqual(['bytes', 'name']);
    expect(picked.name).toBe('photo.png');
    expect(Buffer.from(picked.bytes).equals(png)).toBe(true);
  });

  it('accept PNG, JPEG, WebP, GIF and BMP by their magic bytes', async () => {
    const s = await setup();
    const heads: Record<string, number[]> = {
      'a.jpg': [0xff, 0xd8, 0xff, 0xe0],
      'a.gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
      'a.bmp': [0x42, 0x4d, 0, 0],
      'a.webp': [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50],
    };
    for (const [name, head] of Object.entries(heads)) {
      pickFile(name, Buffer.from([...head, 0, 0, 0, 0]));
      expect(await s.call('editor:pickImage'), name).toMatchObject({ name });
    }
  });

  it('refuse a file that is not a picture, whatever its extension says', async () => {
    const s = await setup();
    pickFile('fake.png', Buffer.from('MZ this is not a picture'));
    await expect(s.call('shot:openImage')).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});

describe('shot:importImage', () => {
  it('starts an editor session of kind import and saves nothing', async () => {
    const s = await setup();
    const { session } = await s.call('shot:importImage', {
      png: arrayBuffer(pngBytes(40, 30)),
    });
    expect(session).toMatchObject({ kind: 'import', width: 40, height: 30 });
    expect(await s.store.readOriginal(session.id)).toBeDefined();
    // Not a capture: nothing reached the screenshots folder or History.
    expect(fs.readdirSync(path.join(root, 'out'))).toEqual([]);
    expect((await s.history.list()).total).toBe(0);
    // The renderer can fetch the session like any other.
    expect((await s.call('shot:get', { sessionId: session.id })).session.id).toBe(session.id);
  });

  it('refuses bytes that are not a PNG, and a picture beyond the frame limit', async () => {
    const s = await setup();
    await expect(
      s.call('shot:importImage', { png: arrayBuffer(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])) }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(
      s.call('shot:importImage', { png: arrayBuffer(pngBytes(MAX_FRAME_DIMENSION + 1, 10)) }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('exports as history source "unknown" and a re-edit of that item is an import session', async () => {
    const s = await setup();
    const { session } = await s.call('shot:importImage', { png: arrayBuffer(pngBytes(30, 20)) });
    hoisted.save.value = path.join(root, 'out', 'edited.png');
    await s.call('shot:export', {
      sessionId: session.id,
      format: 'png',
      bytes: arrayBuffer(pngBytes(30, 20, 'flat')),
      project: { doc: SAMPLE_DOC },
    });
    const [item] = (await s.history.list()).items;
    expect(item?.source).toBe('unknown');
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(opened.session.kind).toBe('import');
  });
});

describe('editor:historyImage', () => {
  it('returns the saved screenshot as PNG for an owned history id only', async () => {
    const s = await setup();
    const { session } = await s.call('shot:importImage', { png: arrayBuffer(pngBytes(30, 20)) });
    hoisted.save.value = path.join(root, 'out', 'saved.png');
    const flat = pngBytes(30, 20, 'flat');
    await s.call('shot:export', {
      sessionId: session.id,
      format: 'png',
      bytes: arrayBuffer(flat),
    });
    const [item] = (await s.history.list()).items;
    const result = await s.call('editor:historyImage', { historyId: item!.id });
    expect(Buffer.from(result.png).equals(flat)).toBe(true);
    await expect(
      s.call('editor:historyImage', { historyId: '77777777-7777-4777-8777-777777777777' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('image-layer pictures in a project', () => {
  const picture = pngBytes(12, 9, 'picture');

  it('are stored with the project, come back on re-edit, and stale ones are deleted', async () => {
    const s = await setup();
    const { session } = await s.call('shot:importImage', { png: arrayBuffer(pngBytes(30, 20)) });
    hoisted.save.value = path.join(root, 'out', 'layers.png');
    await s.call('shot:export', {
      sessionId: session.id,
      format: 'png',
      bytes: arrayBuffer(pngBytes(30, 20, 'flat')),
      project: {
        doc: SAMPLE_DOC,
        assets: [{ id: sha(picture), png: arrayBuffer(picture) }],
      },
    });
    const [item] = (await s.history.list()).items;
    const assetFile = path.join(root, 'projects', item!.id, 'assets', `${sha(picture)}.png`);
    expect(fs.existsSync(assetFile)).toBe(true);

    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(opened.edit.assets).toHaveLength(1);
    expect(opened.edit.assets[0].id).toBe(sha(picture));
    expect(Buffer.from(opened.edit.assets[0].png).equals(picture)).toBe(true);

    // Saving over without the picture (the layer was deleted) removes its file.
    await s.call('shot:saveOver', {
      sessionId: opened.session.id,
      format: 'png',
      bytes: arrayBuffer(pngBytes(30, 20, 'flat2')),
      project: { doc: SAMPLE_DOC },
    });
    expect(fs.existsSync(assetFile)).toBe(false);
    const again = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(again.edit.assets).toEqual([]);
  });

  it('a picture whose bytes do not match its id rejects the project, not the image', async () => {
    const s = await setup();
    const { session } = await s.call('shot:importImage', { png: arrayBuffer(pngBytes(30, 20)) });
    hoisted.save.value = path.join(root, 'out', 'bad.png');
    await s.call('shot:export', {
      sessionId: session.id,
      format: 'png',
      bytes: arrayBuffer(pngBytes(30, 20, 'flat')),
      project: { doc: SAMPLE_DOC, assets: [{ id: 'f'.repeat(64), png: arrayBuffer(picture) }] },
    });
    const [item] = (await s.history.list()).items;
    expect(item?.editable).toBe(false);
    expect(fs.existsSync(path.join(root, 'out', 'bad.png'))).toBe(true);
  });
});
