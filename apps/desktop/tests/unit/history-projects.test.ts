/**
 * Editable projects in history: a project belongs to its history item (same id), is
 * written before the item is listed, follows overwrites, and goes away with the item.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryService } from '../../src/main/history/service';
import { ProjectStore } from '../../src/main/projects/store';
import { fakeTools } from './fake-tools';
import { pngBytes, SAMPLE_DOC } from './project-fixtures';

let dir: string;
let files: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-hproj-'));
  files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const historyDir = (): string => path.join(dir, 'history');
const projects = (): ProjectStore => new ProjectStore(path.join(dir, 'projects'));

function serviceFor(store = projects(), undoWindowMs = 40) {
  return new HistoryService({
    dir: historyDir(),
    projects: store,
    tools: fakeTools(),
    trashItem: async (file) => fs.rmSync(file),
    undoWindowMs,
  });
}

const projectInput = () => ({
  png: pngBytes(10, 10, 'original'),
  doc: SAMPLE_DOC,
  width: 10,
  height: 10,
  appVersion: '1',
});

async function addShot(
  service: HistoryService,
  name = 'a.png',
  extra: { project?: boolean; derivedFrom?: string } = {},
) {
  const file = path.join(files, name);
  fs.writeFileSync(file, pngBytes(10, 10, 'flat'));
  return service.addScreenshot({
    path: file,
    width: 10,
    height: 10,
    sizeBytes: 56,
    format: 'png',
    source: 'region',
    ...(extra.project && { project: projectInput() }),
    ...(extra.derivedFrom && { derivedFrom: extra.derivedFrom }),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('adding a screenshot with a project', () => {
  it('stores the project under the item id before it is listed, and marks the view editable', async () => {
    const store = projects();
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png', { project: true });
    expect((await store.read(id)).ok).toBe(true);
    const [item] = (await service.list()).items;
    expect(item).toMatchObject({ id, editable: true, derivedFrom: null });
  });

  it('an item without a project is not editable; derivedFrom is kept', async () => {
    const service = serviceFor();
    const first = await addShot(service, 'a.png');
    const copy = await addShot(service, 'b.png', { project: true, derivedFrom: first.id });
    const items = (await service.list()).items;
    expect(items.find((i) => i.id === first.id)?.editable).toBe(false);
    expect(items.find((i) => i.id === copy.id)).toMatchObject({
      editable: true,
      derivedFrom: first.id,
    });
  });

  it('a project that cannot be written still lets the item through, as not editable', async () => {
    const store = projects();
    vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png', { project: true });
    expect((await service.list()).items.find((i) => i.id === id)?.editable).toBe(false);
  });

  it('works without a project store (older wiring) and loads items that have no projectId', async () => {
    const service = new HistoryService({
      dir: historyDir(),
      tools: fakeTools(),
      trashItem: async () => undefined,
    });
    const { id } = await addShot(service, 'a.png', { project: true });
    expect((await service.list()).items.find((i) => i.id === id)?.editable).toBe(false);
  });
});

describe('overwriteScreenshot', () => {
  it('replaces the file atomically, updates size and dimensions, and updates the project', async () => {
    const store = projects();
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png', { project: true });
    const next = pngBytes(20, 12, 'edited');
    const result = await service.overwriteScreenshot(id, {
      bytes: next,
      format: 'png',
      width: 20,
      height: 12,
      project: { doc: { schema: 2, annotations: [] }, appVersion: '2' },
    });
    expect(result.editable).toBe(true);
    expect(fs.readFileSync(path.join(files, 'a.png')).equals(next)).toBe(true);
    expect(fs.readdirSync(files).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const [item] = (await service.list()).items;
    expect(item).toMatchObject({ width: 20, height: 12, sizeBytes: next.byteLength });
    const read = await store.read(id);
    expect(read.ok && read.doc).toEqual({ schema: 2, annotations: [] });
  });

  it('creates the project from the base image when the item had none', async () => {
    const store = projects();
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png');
    const result = await service.overwriteScreenshot(id, {
      bytes: pngBytes(10, 10, 'edited'),
      format: 'png',
      width: 10,
      height: 10,
      project: {
        doc: SAMPLE_DOC,
        appVersion: '2',
        base: { png: pngBytes(10, 10, 'base'), width: 10, height: 10 },
      },
    });
    expect(result.editable).toBe(true);
    expect((await store.read(id)).ok).toBe(true);
  });

  it('a failing write leaves the original image and its project untouched', async () => {
    const store = projects();
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png', { project: true });
    const before = fs.readFileSync(path.join(files, 'a.png'));
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('crash'));
    await expect(
      service.overwriteScreenshot(id, {
        bytes: pngBytes(20, 12, 'edited'),
        format: 'png',
        width: 20,
        height: 12,
        project: { doc: { schema: 2, annotations: [] }, appVersion: '2' },
      }),
    ).rejects.toThrow('crash');
    rename.mockRestore();
    expect(fs.readFileSync(path.join(files, 'a.png')).equals(before)).toBe(true);
    expect(fs.readdirSync(files).filter((n) => n.startsWith('.'))).toEqual([]);
    const read = await store.read(id);
    expect(read.ok && read.doc).toEqual(SAMPLE_DOC);
    expect((await service.list()).items[0]).toMatchObject({ width: 10, height: 10 });
  });

  it('refuses another format, a moved file, or a file that is not the saved image', async () => {
    const service = serviceFor();
    const { id } = await addShot(service, 'a.png');
    const body = { bytes: pngBytes(10, 10), width: 10, height: 10 };
    await expect(
      service.overwriteScreenshot(id, { ...body, format: 'jpeg' }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    fs.writeFileSync(path.join(files, 'a.png'), 'not an image at all');
    await expect(service.overwriteScreenshot(id, { ...body, format: 'png' })).rejects.toMatchObject(
      { code: 'INVALID_PAYLOAD' },
    );
    fs.rmSync(path.join(files, 'a.png'));
    await expect(service.overwriteScreenshot(id, { ...body, format: 'png' })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('only overwrites an item that is in history', async () => {
    const service = serviceFor();
    const body = { bytes: pngBytes(10, 10), format: 'png' as const, width: 10, height: 10 };
    await expect(
      service.overwriteScreenshot('00000000-0000-4000-8000-000000000000', body),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('deleting a project', () => {
  it('removes the project and keeps the entry', async () => {
    const store = projects();
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png', { project: true });
    await service.deleteProject(id);
    expect(store.has(id)).toBe(false);
    expect((await service.list()).items[0]).toMatchObject({ id, editable: false });
  });
});

describe('removing items removes their projects', () => {
  it('deleteFile removes the project at once', async () => {
    const store = projects();
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png', { project: true });
    await service.deleteFile(id);
    expect(store.has(id)).toBe(false);
  });

  it('remove keeps the project during the undo window, and drops it when the window ends', async () => {
    const store = projects();
    const service = serviceFor(store, 30);
    const { id } = await addShot(service, 'a.png', { project: true });
    await service.remove(id);
    expect(store.has(id)).toBe(true);
    await sleep(120);
    expect(store.has(id)).toBe(false);
  });

  it('undoing a removal keeps the project', async () => {
    const store = projects();
    const service = serviceFor(store, 60);
    const { id } = await addShot(service, 'a.png', { project: true });
    await service.remove(id);
    await service.undoRemove(id);
    await sleep(150);
    expect(store.has(id)).toBe(true);
    expect((await service.list()).items[0]).toMatchObject({ id, editable: true });
  });

  it('clearMissing removes the projects of entries whose file is gone', async () => {
    const store = projects();
    const service = serviceFor(store);
    const { id } = await addShot(service, 'a.png', { project: true });
    fs.rmSync(path.join(files, 'a.png'));
    expect(await service.clearMissing()).toBe(1);
    expect(store.has(id)).toBe(false);
  });

  it('startup sweeps orphaned projects past the grace period and nothing else', async () => {
    const store = projects();
    const first = serviceFor(store);
    const { id } = await addShot(first, 'a.png', { project: true });
    await first.idle();
    const orphan = '55555555-5555-4555-8555-555555555555';
    const recent = '66666666-6666-4666-8666-666666666666';
    await store.write(orphan, projectInput());
    await store.write(recent, projectInput());
    const longAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(store.rootDir, orphan), longAgo, longAgo);
    const second = serviceFor(store);
    await second.idle();
    expect(store.has(orphan)).toBe(false);
    expect(store.has(recent)).toBe(true);
    expect(store.has(id)).toBe(true);
  });
});
