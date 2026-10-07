/**
 * Quick save (shot:quickSave): the editor's save with no dialog, into the screenshots folder, under a
 * free name, written atomically, validated exactly like shot:export.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (request: unknown, ctx: { webContentsId: number; role: string }) => unknown
  >(),
  dialogCalls: { count: 0 },
}));
vi.mock('electron', () => ({
  clipboard: {},
  ClipboardItem: class {},
  dialog: {
    showSaveDialog: async () => {
      hoisted.dialogCalls.count += 1;
      return { canceled: true };
    },
  },
  // A JPEG save is decoded to PNG for the auto-copy.
  nativeImage: { createFromBuffer: () => ({ toPNG: () => Buffer.from('png') }) },
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
  closeGuard: { setDirty: () => undefined, resolve: () => false },
  getMainWindow: () => undefined,
  onMainWindowClosed: () => undefined,
  setEditorState: () => undefined,
  setQuitting: () => undefined,
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
import { fakeTools } from './fake-tools';
import { pngBytes } from './project-fixtures';

const ctx = { webContentsId: 1, role: 'main' };

let root: string;
beforeEach(() => {
  hoisted.handlers.clear();
  hoisted.dialogCalls.count = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-quick-'));
});

async function setup(outDir = path.join(root, 'out', 'nested')) {
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const store = new ShotSessionStore(path.join(root, 'shots'));
  const projects = new ProjectStore(path.join(root, 'projects'));
  const historyDir = path.join(root, 'history');
  const history = new HistoryService({
    dir: historyDir,
    projects,
    tools: fakeTools(),
    trashItem: async (file) => fs.rmSync(file),
  });
  registerShotHandlers(
    {} as never,
    store,
    { selecting: false } as never,
    history,
    { get: () => settings, screenshotsDir: () => outDir, copyImage: async () => false },
    { store: projects, appVersion: '1.0.0' },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (channel: string, request: unknown): Promise<any> =>
    Promise.resolve().then(() => hoisted.handlers.get(channel)?.(request, ctx));
  const session = async () =>
    store.create({ kind: 'region', width: 30, height: 20, png: pngBytes(30, 20, 'orig') });
  return { call, store, history, session, outDir };
}

const buffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const payload = (sessionId: string, format: 'png' | 'jpeg' = 'png') => ({
  sessionId,
  format,
  bytes: buffer(pngBytes(30, 20, 'flat')),
});

describe('shot:quickSave', () => {
  it('writes into the screenshots folder (made on demand) with no dialog and lists it in history', async () => {
    const s = await setup();
    const session = await s.session();
    const result = await s.call('shot:quickSave', payload(session.id));
    expect(path.dirname(result.path)).toBe(s.outDir);
    expect(path.basename(result.path)).toMatch(
      /^FrameCapt \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/,
    );
    expect(fs.readFileSync(result.path).toString('latin1')).toContain('flat');
    expect(hoisted.dialogCalls.count).toBe(0);
    const listed = (await s.history.list()).items;
    expect(listed.map((item) => item.path)).toEqual([result.path]);
    // Atomic write: no temporary file is left behind.
    expect(fs.readdirSync(s.outDir)).toEqual([path.basename(result.path)]);
  });

  it('never overwrites: a second save in the same second gets a free name', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 4, 3, 10, 11, 12));
      const s = await setup();
      const first = await s.call('shot:quickSave', payload((await s.session()).id));
      const second = await s.call('shot:quickSave', payload((await s.session()).id));
      expect(path.basename(first.path)).toBe('FrameCapt 2026-05-03 at 10.11.12.png');
      expect(path.basename(second.path)).toBe('FrameCapt 2026-05-03 at 10.11.12 (2).png');
      expect(fs.readdirSync(s.outDir)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves JPEG with the jpg extension, and refuses a PNG labelled JPEG', async () => {
    const s = await setup();
    const session = await s.session();
    await expect(s.call('shot:quickSave', payload(session.id, 'jpeg'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.alloc(40)]);
    const result = await s.call('shot:quickSave', {
      sessionId: session.id,
      format: 'jpeg',
      bytes: buffer(jpeg),
    });
    expect(path.extname(result.path)).toBe('.jpg');
  });

  it('refuses an invalid image and an unknown session, writing nothing', async () => {
    const s = await setup();
    const mine = await s.session();
    await expect(
      s.call('shot:quickSave', { ...payload(mine.id), bytes: buffer(Buffer.from('not an image')) }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(s.call('shot:quickSave', payload('does-not-exist'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(fs.existsSync(s.outDir) ? fs.readdirSync(s.outDir) : []).toEqual([]);
  });

  it('a folder that cannot be created is an error and nothing is saved', async () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'a file where the folder should be');
    const s = await setup(path.join(blocker, 'shots'));
    const session = await s.session();
    await expect(s.call('shot:quickSave', payload(session.id))).rejects.toBeTruthy();
    expect((await s.history.list()).items).toEqual([]);
  });
});
