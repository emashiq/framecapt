import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VideoProjectStore, VIDEO_PROJECT_FILE } from '../../src/main/video-projects/store';
import { applyCommand, createProject, newItem } from '../../src/shared/video-edit';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SOURCE = { durationMs: 10_000, width: 1280, height: 720, hasAudio: true };

let root: string;
let store: VideoProjectStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-video-projects-'));
  store = new VideoProjectStore(path.join(root, 'video-projects'), () => 1234);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const fileOf = (id: string): string => path.join(store.rootDir, id, VIDEO_PROJECT_FILE);
const project = () =>
  applyCommand(createProject(ID, SOURCE), {
    type: 'addItem',
    item: newItem('redact', 'r1', { x: 10, y: 10, width: 100, height: 50 }, 0, 2000),
  });

describe('VideoProjectStore', () => {
  it('writes project.json atomically and reads it back', async () => {
    await store.write(ID, project());
    expect(store.has(ID)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fileOf(ID), 'utf8')).version).toBe(1);
    expect(fs.readdirSync(path.dirname(fileOf(ID)))).toEqual([VIDEO_PROJECT_FILE]);
    const read = await store.read(ID);
    expect(read).toEqual({ ok: true, project: project() });
  });

  it('reports a missing project', async () => {
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'missing' });
    expect(store.has(ID)).toBe(false);
  });

  it('only knows history ids: nothing else becomes a path', async () => {
    for (const id of ['../x', '..', 'a/b', '', 'not-an-id']) {
      expect(store.dirFor(id)).toBeNull();
      await expect(store.write(id, project())).rejects.toThrow();
      expect(await store.read(id)).toEqual({ ok: false, reason: 'missing' });
    }
  });

  it('sets a damaged file aside instead of deleting it', async () => {
    fs.mkdirSync(path.dirname(fileOf(ID)), { recursive: true });
    fs.writeFileSync(fileOf(ID), '{ not json');
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'corrupt' });
    expect(fs.existsSync(fileOf(ID))).toBe(false);
    expect(
      fs.readFileSync(path.join(path.dirname(fileOf(ID)), 'project.corrupt-1234.json'), 'utf8'),
    ).toBe('{ not json');
    // The next save starts fresh.
    await store.write(ID, project());
    expect((await store.read(ID)).ok).toBe(true);
  });

  it('sets aside a file that has the wrong shape or belongs to another item', async () => {
    fs.mkdirSync(path.dirname(fileOf(ID)), { recursive: true });
    fs.writeFileSync(fileOf(ID), JSON.stringify({ ...project(), crop: 'x' }));
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'corrupt' });
    fs.mkdirSync(path.dirname(fileOf(OTHER)), { recursive: true });
    fs.writeFileSync(fileOf(OTHER), JSON.stringify(project()));
    expect(await store.read(OTHER)).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('keeps a project written by a newer version, aside', async () => {
    fs.mkdirSync(path.dirname(fileOf(ID)), { recursive: true });
    fs.writeFileSync(fileOf(ID), JSON.stringify({ ...project(), version: 2 }));
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'newer_version' });
    expect(fs.existsSync(path.join(path.dirname(fileOf(ID)), 'project.newer-1234.json'))).toBe(
      true,
    );
  });

  it('normalizes what it reads', async () => {
    fs.mkdirSync(path.dirname(fileOf(ID)), { recursive: true });
    const wide = {
      ...createProject(ID, SOURCE),
      items: [newItem('blur', 'b', { x: 1200, y: 700, width: 300, height: 300 }, 0, 500)],
    };
    fs.writeFileSync(fileOf(ID), JSON.stringify(wide));
    const read = await store.read(ID);
    expect(read.ok && read.project.items[0]?.rect).toEqual({
      x: 980,
      y: 420,
      width: 300,
      height: 300,
    });
  });

  it('removes a project folder and is idempotent', async () => {
    await store.write(ID, project());
    await store.remove(ID);
    await store.remove(ID);
    await store.remove('../../x');
    expect(store.has(ID)).toBe(false);
  });

  it('sweeps unknown projects older than the grace period and nothing else', async () => {
    await store.write(ID, project());
    await store.write(OTHER, { ...project(), sourceId: OTHER });
    fs.writeFileSync(path.join(store.rootDir, 'notes.txt'), 'keep');
    fs.mkdirSync(path.join(store.rootDir, 'not-an-id'));
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(store.rootDir, OTHER), old, old);
    const sweeper = new VideoProjectStore(store.rootDir);
    const result = await sweeper.sweep(new Set([ID]));
    expect(result).toEqual({ scanned: 2, removed: 1 });
    expect(sweeper.has(ID)).toBe(true);
    expect(sweeper.has(OTHER)).toBe(false);
    expect(fs.existsSync(path.join(store.rootDir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(store.rootDir, 'not-an-id'))).toBe(true);
  });
});
