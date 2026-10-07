/**
 * Re-editing a saved screenshot (Part 1): opening an item in a new editor session (project or
 * flattened copy), saving over it, saving a copy (derivedFrom), and who may do what.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (request: unknown, ctx: { webContentsId: number; role: string }) => unknown
  >(),
  savePath: { value: '' },
}));
vi.mock('electron', () => ({
  clipboard: {},
  ClipboardItem: class {},
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: hoisted.savePath.value }),
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
import { ProjectStore, PROJECT_FILE } from '../../src/main/projects/store';
import { ShotSessionStore } from '../../src/main/shots/session-store';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';
import { fakeTools } from './fake-tools';
import { pngBytes, SAMPLE_DOC } from './project-fixtures';

const ctx = { webContentsId: 1, role: 'main' };

let root: string;
beforeEach(() => {
  hoisted.handlers.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-reedit-'));
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
});

async function setup(keep = true) {
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  /** The PNGs the auto-copy rule was asked to put on the clipboard. */
  const copied: Buffer[] = [];
  settings.screenshots.keepEditableOriginals = keep;
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
    {
      get: () => settings,
      screenshotsDir: () => path.join(root, 'out'),
      copyImage: async (png) => {
        copied.push(Buffer.from(png));
        return true;
      },
    },
    { store: projects, appVersion: '1.0.0' },
  );
  // Handler results are checked field by field below; their types are the channels' own.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (channel: string, request: unknown): Promise<any> =>
    Promise.resolve(hoisted.handlers.get(channel)?.(request, ctx));
  return { call, store, projects, history, settings, copied };
}

/** A capture session saved through shot:export, as the editor does (with a project). */
async function exportCapture(
  s: Awaited<ReturnType<typeof setup>>,
  name = 'shot.png',
  withProject = true,
) {
  const session = await s.store.create({
    kind: 'region',
    width: 30,
    height: 20,
    png: pngBytes(30, 20, 'original'),
  });
  hoisted.savePath.value = path.join(root, 'out', name);
  const result = await s.call('shot:export', {
    sessionId: session.id,
    format: 'png',
    bytes: arrayBuffer(pngBytes(30, 20, 'flat')),
    ...(withProject && { project: { doc: SAMPLE_DOC } }),
  });
  const [item] = (await s.history.list()).items.filter((i) => i.path.endsWith(name));
  return { session, result, item };
}

const arrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

describe('exporting a capture', () => {
  it('stores a project beside the history item, with the unredacted original', async () => {
    const s = await setup();
    const { result, item } = await exportCapture(s);
    expect(result).toEqual({ path: path.join(root, 'out', 'shot.png') }); // capture sessions: as before
    expect(item?.editable).toBe(true);
    const read = await s.projects.read(item!.id);
    expect(read.ok && read.png.toString('latin1').includes('original')).toBe(true);
    // The exported file is the flattened image, not the original.
    expect(fs.readFileSync(path.join(root, 'out', 'shot.png')).toString('latin1')).toContain(
      'flat',
    );
  });

  it('with Keep editable originals off no project is stored', async () => {
    const s = await setup(false);
    const { item } = await exportCapture(s);
    expect(item?.editable).toBe(false);
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
  });

  it('without a project payload none is stored', async () => {
    const s = await setup();
    const { item } = await exportCapture(s, 'plain.png', false);
    expect(item?.editable).toBe(false);
  });
});

describe('shot:openFromHistory', () => {
  it('opens a project: original, document and a session that is discarded like any other', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(opened.edit).toMatchObject({
      historyId: item!.id,
      mode: 'project',
      doc: SAMPLE_DOC,
      notice: null,
      format: 'png',
    });
    expect(Buffer.from(opened.png).toString('latin1')).toContain('original');
    expect(opened.session).toMatchObject({ width: 30, height: 20 });
    // The history file was not touched by opening.
    expect(fs.readFileSync(path.join(root, 'out', 'shot.png')).toString('latin1')).toContain(
      'flat',
    );
    await s.call('shot:discard', { sessionId: opened.session.id });
    expect(s.store.get(opened.session.id)).toBeUndefined();
  });

  it('an item with no project opens the history file as the base image, without a notice', async () => {
    const s = await setup();
    const { item } = await exportCapture(s, 'old.png', false);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(opened.edit).toMatchObject({ mode: 'flattened', doc: null, notice: null });
    expect(Buffer.from(opened.png).toString('latin1')).toContain('flat');
  });

  it('a damaged, tampered or newer project falls back to the flattened image with a notice', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    const file = path.join(root, 'projects', item!.id, PROJECT_FILE);
    const good = fs.readFileSync(file, 'utf8');

    fs.writeFileSync(file, '{broken');
    let opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(opened.edit).toMatchObject({ mode: 'flattened', doc: null });
    expect(opened.edit.notice).toMatch(/damaged/);

    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), version: 7 }));
    opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(opened.edit.notice).toMatch(/newer FrameCapt/);

    fs.rmSync(path.join(root, 'projects', item!.id), { recursive: true });
    opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    expect(opened.edit.notice).toMatch(/missing/);
    expect(opened.edit.mode).toBe('flattened');
  });

  it('a missing file or an unknown id is NOT_FOUND', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    fs.rmSync(path.join(root, 'out', 'shot.png'));
    await expect(s.call('shot:openFromHistory', { historyId: item!.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      s.call('shot:openFromHistory', { historyId: '77777777-7777-4777-8777-777777777777' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('saving a re-edit', () => {
  it('Save overwrites the history file and updates the project; the original stays', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    const next = pngBytes(30, 20, 'second');
    const saved = await s.call('shot:saveOver', {
      sessionId: opened.session.id,
      format: 'png',
      bytes: arrayBuffer(next),
      project: { doc: { schema: 2, annotations: [] } },
    });
    expect(saved).toEqual({
      historyId: item!.id,
      path: path.join(root, 'out', 'shot.png'),
      editable: true,
    });
    expect(fs.readFileSync(path.join(root, 'out', 'shot.png')).equals(next)).toBe(true);
    const read = await s.projects.read(item!.id);
    expect(read.ok && read.doc).toEqual({ schema: 2, annotations: [] });
    expect(read.ok && read.png.toString('latin1')).toContain('original');
    expect((await s.history.list()).items).toHaveLength(1);
  });

  it('auto-copy puts the SAVED (flattened, redacted) image on the clipboard after an edit, never the original', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    // The export itself copied the flattened pixels, not the unredacted original of the session.
    expect(s.copied).toHaveLength(1);
    expect(s.copied[0]?.toString('latin1')).toContain('flat');
    expect(s.copied[0]?.toString('latin1')).not.toContain('original');
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    const next = pngBytes(30, 20, 'redacted-edit');
    await s.call('shot:saveOver', {
      sessionId: opened.session.id,
      format: 'png',
      bytes: arrayBuffer(next),
      project: { doc: { schema: 2, annotations: [] } },
    });
    expect(s.copied).toHaveLength(2);
    expect(s.copied[1]?.equals(next)).toBe(true);
    expect(s.copied[1]?.toString('latin1')).not.toContain('original');
  });

  it('with auto-copy off nothing is copied on save', async () => {
    const s = await setup();
    s.settings.screenshots.autoCopy = false;
    const { item } = await exportCapture(s);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    await s.call('shot:saveOver', {
      sessionId: opened.session.id,
      format: 'png',
      bytes: arrayBuffer(pngBytes(30, 20, 'second')),
      project: { doc: { schema: 2, annotations: [] } },
    });
    expect(s.copied).toEqual([]);
  });

  it('Save over an old flattened item creates a project from the base image', async () => {
    const s = await setup();
    const { item } = await exportCapture(s, 'old.png', false);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    const saved = await s.call('shot:saveOver', {
      sessionId: opened.session.id,
      format: 'png',
      bytes: arrayBuffer(pngBytes(30, 20, 'second')),
      project: { doc: SAMPLE_DOC },
    });
    expect(saved.editable).toBe(true);
    expect((await s.projects.read(item!.id)).ok).toBe(true);
  });

  it('with Keep editable originals off, an old item gets no project but an existing one follows', async () => {
    const s = await setup(true);
    const withProject = await exportCapture(s, 'a.png');
    const without = await exportCapture(s, 'b.png', false);
    s.settings.screenshots.keepEditableOriginals = false;
    for (const [entry, expected] of [
      [withProject, true],
      [without, false],
    ] as const) {
      const opened = await s.call('shot:openFromHistory', { historyId: entry.item!.id });
      const saved = await s.call('shot:saveOver', {
        sessionId: opened.session.id,
        format: 'png',
        bytes: arrayBuffer(pngBytes(30, 20, 'again')),
        project: { doc: { schema: 2, annotations: [] } },
      });
      expect(saved.editable).toBe(expected);
    }
  });

  it('refuses another format and an unlinked (capture) session', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    const bytes = arrayBuffer(pngBytes(30, 20));
    await expect(
      s.call('shot:saveOver', { sessionId: opened.session.id, format: 'jpeg', bytes }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    const capture = await s.store.create({
      kind: 'region',
      width: 30,
      height: 20,
      png: pngBytes(30, 20),
    });
    await expect(
      s.call('shot:saveOver', { sessionId: capture.id, format: 'png', bytes }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('Save as copy makes a new item with derivedFrom and its own project, then edits the copy', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    hoisted.savePath.value = path.join(root, 'out', 'copy.png');
    const saved = await s.call('shot:export', {
      sessionId: opened.session.id,
      format: 'png',
      bytes: arrayBuffer(pngBytes(30, 20, 'copy')),
      project: { doc: { schema: 2, annotations: [] } },
    });
    expect(saved.path).toBe(path.join(root, 'out', 'copy.png'));
    expect(saved.historyId).toBeTruthy();
    expect(saved.historyId).not.toBe(item!.id);
    const items = (await s.history.list()).items;
    const copy = items.find((i) => i.id === saved.historyId);
    expect(copy).toMatchObject({ derivedFrom: item!.id, editable: true });
    expect((await s.projects.read(copy!.id)).ok).toBe(true);
    // The source item and its project are unchanged.
    expect(fs.readFileSync(path.join(root, 'out', 'shot.png')).toString('latin1')).toContain(
      'flat',
    );
    const source = await s.projects.read(item!.id);
    expect(source.ok && source.doc).toEqual(SAMPLE_DOC);
    // The session now edits the copy: Save overwrites copy.png, not shot.png.
    const next = pngBytes(30, 20, 'third');
    await s.call('shot:saveOver', {
      sessionId: opened.session.id,
      format: 'png',
      bytes: arrayBuffer(next),
    });
    expect(fs.readFileSync(path.join(root, 'out', 'copy.png')).equals(next)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'out', 'shot.png')).toString('latin1')).toContain(
      'flat',
    );
  });

  it('discarding the session unlinks it', async () => {
    const s = await setup();
    const { item } = await exportCapture(s);
    const opened = await s.call('shot:openFromHistory', { historyId: item!.id });
    await s.call('shot:discard', { sessionId: opened.session.id });
    await expect(
      s.call('shot:saveOver', {
        sessionId: opened.session.id,
        format: 'png',
        bytes: arrayBuffer(pngBytes(30, 20)),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
