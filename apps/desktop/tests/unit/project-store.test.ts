/** The editable project store: format, verification, ownership-by-id plumbing and sweep safety. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_TOOL_VERSION, PROJECT_VERSION } from '../../src/shared/project-ipc';
import { PROJECT_FILE, PROJECT_ORIGINAL, ProjectStore } from '../../src/main/projects/store';
import { pngBytes, SAMPLE_DOC } from './project-fixtures';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let root: string;
let store: ProjectStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-projects-'));
  store = new ProjectStore(path.join(root, 'projects'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const input = (png = pngBytes(40, 30)) => ({
  png,
  doc: SAMPLE_DOC,
  width: 40,
  height: 30,
  appVersion: '1.2.3',
});
const fileOf = (id: string, name: string): string => path.join(store.rootDir, id, name);

describe('ProjectStore', () => {
  it('writes original.png and project.json and reads them back verified', async () => {
    const png = pngBytes(40, 30);
    await store.write(ID, input(png));
    const json = JSON.parse(fs.readFileSync(fileOf(ID, PROJECT_FILE), 'utf8'));
    expect(json).toMatchObject({
      version: PROJECT_VERSION,
      width: 40,
      height: 30,
      appVersion: '1.2.3',
      toolVersion: EDITOR_TOOL_VERSION,
      doc: SAMPLE_DOC,
    });
    expect(json.baseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readdirSync(path.join(store.rootDir, ID)).sort()).toEqual([
      PROJECT_ORIGINAL,
      PROJECT_FILE,
    ]);
    const read = await store.read(ID);
    expect(read).toMatchObject({ ok: true, doc: SAMPLE_DOC, width: 40, height: 30 });
    expect(read.ok && read.png.equals(png)).toBe(true);
  });

  it('refuses an image that does not match the stated size', async () => {
    await expect(store.write(ID, { ...input(), width: 41 })).rejects.toThrow();
    expect(store.has(ID)).toBe(false);
  });

  it('updateDoc replaces the document only', async () => {
    await store.write(ID, input());
    const before = fs.readFileSync(fileOf(ID, PROJECT_ORIGINAL));
    expect(await store.updateDoc(ID, { schema: 2, annotations: [] }, '9.9.9')).toBe(true);
    const read = await store.read(ID);
    expect(read.ok && read.doc).toEqual({ schema: 2, annotations: [] });
    expect(fs.readFileSync(fileOf(ID, PROJECT_ORIGINAL)).equals(before)).toBe(true);
    expect(await store.updateDoc(OTHER, SAMPLE_DOC, '1')).toBe(false);
  });

  it('reports missing, corrupt, newer version, sha mismatch and dimension mismatch', async () => {
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'missing' });
    await store.write(ID, input());

    fs.writeFileSync(fileOf(ID, PROJECT_FILE), '{not json');
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'corrupt' });

    await store.write(ID, input());
    const good = JSON.parse(fs.readFileSync(fileOf(ID, PROJECT_FILE), 'utf8'));
    fs.writeFileSync(fileOf(ID, PROJECT_FILE), JSON.stringify({ ...good, version: 99 }));
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'newer_version' });

    fs.writeFileSync(fileOf(ID, PROJECT_FILE), JSON.stringify({ ...good, doc: 'nope' }));
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'corrupt' });

    fs.writeFileSync(fileOf(ID, PROJECT_FILE), JSON.stringify(good));
    fs.writeFileSync(fileOf(ID, PROJECT_ORIGINAL), pngBytes(40, 30, 'tampered'));
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'sha_mismatch' });

    // A matching hash but another size.
    const wide = pngBytes(50, 30);
    fs.writeFileSync(fileOf(ID, PROJECT_ORIGINAL), wide);
    const sha = createHash('sha256').update(wide).digest('hex');
    fs.writeFileSync(fileOf(ID, PROJECT_FILE), JSON.stringify({ ...good, baseSha256: sha }));
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'dimension_mismatch' });

    fs.rmSync(fileOf(ID, PROJECT_ORIGINAL));
    expect(await store.read(ID)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects ids that are not plain history ids (no traversal, no names)', async () => {
    const bad = ['..', '../x', `${ID}/..`, '..\\..\\x', `${ID}/../${OTHER}`, 'original', ''];
    for (const id of bad) {
      expect(store.dirFor(id), id).toBeNull();
      expect(await store.read(id)).toEqual({ ok: false, reason: 'missing' });
      await expect(store.write(id, input())).rejects.toThrow();
      await store.remove(id); // a no-op
    }
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
  });

  it('a crash while writing the project file leaves the previous project intact', async () => {
    await store.write(ID, input());
    const before = fs.readFileSync(fileOf(ID, PROJECT_FILE), 'utf8');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('crash'));
    await expect(store.updateDoc(ID, { schema: 2, annotations: [] }, '1')).rejects.toThrow('crash');
    rename.mockRestore();
    expect(fs.readFileSync(fileOf(ID, PROJECT_FILE), 'utf8')).toBe(before);
    const leftovers = fs
      .readdirSync(path.join(store.rootDir, ID))
      .filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect((await store.read(ID)).ok).toBe(true);
  });

  it('remove deletes one project and is idempotent', async () => {
    await store.write(ID, input());
    await store.write(OTHER, input());
    await store.remove(ID);
    await store.remove(ID);
    expect(store.has(ID)).toBe(false);
    expect(store.has(OTHER)).toBe(true);
  });

  describe('sweep', () => {
    it('removes only old, unreferenced, id-named folders', async () => {
      const old = '33333333-3333-4333-8333-333333333333';
      const recent = '44444444-4444-4444-8444-444444444444';
      for (const id of [ID, old, recent]) await store.write(id, input());
      fs.mkdirSync(path.join(store.rootDir, 'not-an-id'));
      fs.writeFileSync(path.join(store.rootDir, 'stray.txt'), 'x');
      fs.mkdirSync(path.join(root, 'outside'));
      fs.writeFileSync(path.join(root, 'outside', 'keep.txt'), 'x');
      const longAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      fs.utimesSync(path.join(store.rootDir, ID), longAgo, longAgo);
      fs.utimesSync(path.join(store.rootDir, old), longAgo, longAgo);
      fs.utimesSync(path.join(store.rootDir, 'not-an-id'), longAgo, longAgo);

      const result = await store.sweep(new Set([ID]));
      expect(result).toEqual({ scanned: 3, removed: 1 });
      expect(store.has(ID)).toBe(true); // referenced
      expect(store.has(old)).toBe(false); // orphaned and past the grace period
      expect(store.has(recent)).toBe(true); // orphaned but inside the grace period
      expect(fs.existsSync(path.join(store.rootDir, 'not-an-id'))).toBe(true);
      expect(fs.existsSync(path.join(store.rootDir, 'stray.txt'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'outside', 'keep.txt'))).toBe(true);
    });

    it('a missing root is not an error', async () => {
      expect(await new ProjectStore(path.join(root, 'nothing')).sweep(new Set())).toEqual({
        scanned: 0,
        removed: 0,
      });
    });
  });
});

describe('ProjectStore image-layer pictures', () => {
  const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const asset = (filler: string, width = 10, height = 8) => {
    const png = pngBytes(width, height, filler);
    return { id: sha(png), png };
  };
  const assetFile = (id: string, hash: string): string => fileOf(id, `assets/${hash}.png`);

  it('writes assets/<sha256>.png before the project and reads them back', async () => {
    const [a, b] = [asset('a'), asset('b')];
    await store.write(ID, { ...input(), assets: [a, b] });
    expect(fs.existsSync(assetFile(ID, a.id))).toBe(true);
    const read = await store.read(ID);
    expect(read.ok && read.assets.map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
    expect(read.ok && read.assets.find((item) => item.id === a.id)?.png.equals(a.png)).toBe(true);
  });

  it('a project without assets has none (old projects keep working)', async () => {
    await store.write(ID, input());
    expect(fs.existsSync(fileOf(ID, 'assets'))).toBe(false);
    const read = await store.read(ID);
    expect(read.ok && read.assets).toEqual([]);
  });

  it('updateDoc replaces the set: pictures no longer used are deleted', async () => {
    const [a, b] = [asset('a'), asset('b')];
    await store.write(ID, { ...input(), assets: [a, b] });
    expect(await store.updateDoc(ID, SAMPLE_DOC, '1.0.0', [b])).toBe(true);
    expect(fs.existsSync(assetFile(ID, a.id))).toBe(false);
    expect(fs.existsSync(assetFile(ID, b.id))).toBe(true);
    expect(await store.updateDoc(ID, SAMPLE_DOC, '1.0.0')).toBe(true);
    expect(fs.existsSync(fileOf(ID, 'assets'))).toBe(false);
  });

  it('refuses a picture whose bytes do not hash to its id, a non-PNG, an oversized and too many', async () => {
    const good = asset('a');
    const wrongId = { id: 'e'.repeat(64), png: good.png };
    const notPng = Buffer.from('definitely not a png, but long enough to hash');
    const tooBig = asset('x', 20000, 10);
    const many = Array.from({ length: 33 }, (_, index) => asset(String(index)));
    for (const assets of [[wrongId], [{ id: sha(notPng), png: notPng }], [tooBig], many]) {
      await expect(store.write(ID, { ...input(), assets })).rejects.toThrow();
    }
    // Nothing was published: no project.json exists for the failed writes.
    expect(store.has(ID)).toBe(false);
  });

  it('a tampered or renamed picture is skipped on read (its layer shows a placeholder)', async () => {
    const [a, b] = [asset('a'), asset('b')];
    await store.write(ID, { ...input(), assets: [a, b] });
    fs.writeFileSync(assetFile(ID, a.id), pngBytes(10, 8, 'tampered'));
    fs.writeFileSync(fileOf(ID, 'assets/readme.txt'), 'x');
    const read = await store.read(ID);
    expect(read.ok && read.assets.map((item) => item.id)).toEqual([b.id]);
  });
});
