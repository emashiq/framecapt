import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_FILE, HistoryStore, type HistoryItem } from '../../src/main/history/store';
import { THUMB_NAME, ThumbStore, thumbNameFor } from '../../src/main/history/thumbs';
import { matchesQuery } from '../../src/main/history/query';
import { copyFileAtomic, mapLimit } from '../../src/main/history/files';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-history-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
/** A valid uuid-shaped id (the last group counts up). */
function id(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function item(overrides: Partial<HistoryItem> = {}): HistoryItem {
  const itemId = overrides.id ?? id();
  return {
    id: itemId,
    type: 'screenshot',
    createdAt: 1_000,
    path: path.join(dir, `${itemId}.png`),
    width: 100,
    height: 50,
    durationMs: null,
    sizeBytes: 10,
    format: 'png',
    thumbnail: null,
    hasAudio: null,
    source: 'screen',
    derivedFrom: null,
    ...overrides,
  };
}

describe('HistoryStore', () => {
  it('starts empty when there is no file', async () => {
    const store = new HistoryStore(dir);
    expect(await store.load()).toEqual({ existed: false, reset: false });
    expect(store.items()).toEqual([]);
  });

  it('adds, updates, removes and keeps the list newest first across a reload', async () => {
    const store = new HistoryStore(dir);
    await store.load();
    const a = item({ createdAt: 1 });
    const b = item({ createdAt: 3 });
    const c = item({ createdAt: 2 });
    for (const entry of [a, b, c]) await store.put(entry);
    expect(store.items().map((entry) => entry.id)).toEqual([b.id, c.id, a.id]);

    await store.update(a.id, { sizeBytes: 99 });
    expect(await store.remove([c.id])).toHaveLength(1);

    const reloaded = new HistoryStore(dir);
    expect(await reloaded.load()).toEqual({ existed: true, reset: false });
    expect(reloaded.items().map((entry) => entry.id)).toEqual([b.id, a.id]);
    expect(reloaded.get(a.id)?.sizeBytes).toBe(99);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8'));
    expect(onDisk.version).toBe(1);
  });

  it('removes nothing for an unknown id', async () => {
    const store = new HistoryStore(dir);
    await store.load();
    await store.put(item());
    expect(await store.remove([id()])).toEqual([]);
    expect(store.count).toBe(1);
  });

  it('never leaves a temporary file behind', async () => {
    const store = new HistoryStore(dir);
    await store.load();
    await Promise.all([store.put(item()), store.put(item()), store.put(item())]);
    expect(fs.readdirSync(dir)).toEqual([HISTORY_FILE]);
  });

  it('moves a damaged file aside, starts empty and says so', async () => {
    fs.writeFileSync(path.join(dir, HISTORY_FILE), '{ "version": 1, "items": [ nope');
    const store = new HistoryStore(dir, 1000, () => 42);
    expect(await store.load()).toEqual({ existed: true, reset: true });
    expect(store.items()).toEqual([]);
    expect(fs.existsSync(path.join(dir, HISTORY_FILE))).toBe(false);
    expect(fs.readFileSync(path.join(dir, `${HISTORY_FILE}.corrupt-42`), 'utf8')).toContain('nope');
    // The history works again afterwards.
    await store.put(item());
    expect(JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')).items).toHaveLength(1);
  });

  it('treats a wrong version or a damaged top level as damage', async () => {
    for (const body of [{ version: 2, items: [] }, { version: 1 }, { version: 1, items: {} }, []]) {
      fs.writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify(body));
      const store = new HistoryStore(dir);
      expect((await store.load()).reset).toBe(true);
      expect(store.items()).toEqual([]);
    }
  });

  it('keeps items it does not understand, unlisted, and writes them back unchanged', async () => {
    const good = item({ createdAt: 5 });
    const flow = { id: id(), type: 'flow', createdAt: 9, extra: { steps: [1, 2] } };
    const future = { ...item(), format: 'gif' };
    const escape = { ...item(), thumbnail: '../../escape.png' };
    fs.writeFileSync(
      path.join(dir, HISTORY_FILE),
      JSON.stringify({ version: 1, items: [flow, good, future, escape, 7] }),
    );
    const store = new HistoryStore(dir);
    expect(await store.load()).toEqual({ existed: true, reset: false });
    expect(store.items()).toEqual([good]);
    expect(store.get(flow.id)).toBeUndefined();

    const newer = item({ createdAt: 6 });
    await store.put(newer);
    await store.remove([good.id]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8'));
    expect(onDisk.items).toEqual([newer, flow, future, escape, 7]);
    expect(fs.readdirSync(dir)).toEqual([HISTORY_FILE]);
  });

  it('counts unknown items toward the cap', async () => {
    const unknown = [{ type: 'flow' }, { type: 'flow' }];
    fs.writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify({ version: 1, items: unknown }));
    const store = new HistoryStore(dir, 3);
    await store.load();
    await store.put(item({ createdAt: 1 }));
    const dropped = await store.put(item({ createdAt: 2 }));
    expect(dropped.map((entry) => entry.createdAt)).toEqual([1]);
    expect(store.count).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8'));
    expect(onDisk.items).toHaveLength(3);
  });

  it('drops the oldest entries beyond the cap from the list only', async () => {
    const store = new HistoryStore(dir, 3);
    await store.load();
    const files: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const entry = item({ createdAt: index });
      fs.writeFileSync(entry.path, 'x');
      files.push(entry.path);
      const dropped = await store.put(entry);
      if (index > 3) expect(dropped.map((d) => d.createdAt)).toEqual([index - 3]);
    }
    expect(store.items().map((entry) => entry.createdAt)).toEqual([5, 4, 3]);
    // The user's files are never touched by history housekeeping.
    expect(files.every((file) => fs.existsSync(file))).toBe(true);
  });

  it('remembers that earlier recordings were added', async () => {
    const store = new HistoryStore(dir);
    await store.load();
    expect(store.backfilled).toBe(false);
    await store.markBackfilled();
    const reloaded = new HistoryStore(dir);
    await reloaded.load();
    expect(reloaded.backfilled).toBe(true);
  });
});

describe('ThumbStore', () => {
  const png = Buffer.alloc(1000, 1);

  it('writes only names derived from a history id', async () => {
    const thumbs = new ThumbStore(path.join(dir, 'thumbs'));
    const name = thumbNameFor(id());
    await thumbs.write(name, png);
    expect(fs.existsSync(path.join(dir, 'thumbs', name))).toBe(true);
    await expect(thumbs.write('../evil.png', png)).rejects.toThrow();
    expect(thumbs.pathOf('..\\x.png')).toBeUndefined();
    expect(THUMB_NAME.test(name)).toBe(true);
    expect(THUMB_NAME.test(`${name}x`)).toBe(false);
    expect(THUMB_NAME.test(name.replace('.png', 'xpng'))).toBe(false);
  });

  it('deletes thumbnails nothing refers to and nothing else', async () => {
    const thumbs = new ThumbStore(path.join(dir, 'thumbs'));
    const keep = thumbNameFor(id());
    const orphan = thumbNameFor(id());
    await thumbs.write(keep, png);
    await thumbs.write(orphan, png);
    fs.writeFileSync(path.join(dir, 'thumbs', 'notes.txt'), 'not ours');
    fs.writeFileSync(path.join(dir, 'thumbs', `${orphan}.keep`), 'not ours either');
    await thumbs.gc([{ name: keep, createdAt: 1 }]);
    expect(fs.readdirSync(path.join(dir, 'thumbs')).sort()).toEqual(
      [keep, 'notes.txt', `${orphan}.keep`].sort(),
    );
  });

  it('removes interrupted leftovers only once they are old enough to be abandoned', async () => {
    const thumbs = new ThumbStore(path.join(dir, 'thumbs'));
    const itemId = id();
    await fs.promises.mkdir(path.join(dir, 'thumbs'), { recursive: true });
    const leftover = path.join(dir, 'thumbs', `${itemId}.partial.png`);
    fs.writeFileSync(leftover, 'half');
    await thumbs.gc([]); // just written: it may still be in use (default 60 s minimum age)
    expect(fs.existsSync(leftover)).toBe(true);
    await thumbs.gc([], -1000);
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it('keeps the total under the cap by dropping the oldest items thumbnails first', async () => {
    const thumbs = new ThumbStore(path.join(dir, 'thumbs'), 2500);
    const refs = [];
    for (const createdAt of [30, 10, 20, 40]) {
      const name = thumbNameFor(id());
      await thumbs.write(name, png); // 1000 bytes each, 4000 in total
      refs.push({ name, createdAt });
    }
    const dropped = await thumbs.gc(refs);
    // Must free at least 1500 bytes: the two oldest (createdAt 10 and 20) go.
    expect(dropped).toEqual([refs[1]?.name, refs[2]?.name]);
    const left = fs.readdirSync(path.join(dir, 'thumbs')).sort();
    expect(left).toEqual([refs[0]?.name, refs[3]?.name].sort());
    const total = left.reduce(
      (sum, name) => sum + fs.statSync(path.join(dir, 'thumbs', name)).size,
      0,
    );
    expect(total).toBeLessThanOrEqual(2500);
  });
});

describe('matchesQuery', () => {
  const base = {
    type: 'screenshot' as const,
    createdAt: new Date(2026, 9, 2, 14, 5).getTime(),
    path: 'C:\\Users\\x\\Pictures\\FrameCapt\\FrameCapt 2026-10-02 at 14.05.09.png',
    format: 'png' as const,
    source: 'region' as const,
  };

  it('matches name, type, format, source and the date in several spellings', () => {
    for (const query of [
      '',
      '14.05.09',
      'screenshot',
      'image',
      'PNG',
      'region',
      '2026-10-02',
      'october',
      'october 2',
      'FRIDAY',
    ]) {
      expect(matchesQuery(base, query), query).toBe(true);
    }
  });

  it('requires every word and treats non-matches as non-matches', () => {
    expect(matchesQuery(base, 'screenshot video')).toBe(false);
    expect(matchesQuery(base, 'recording')).toBe(false);
    expect(matchesQuery({ ...base, type: 'recording', format: 'webm' }, 'video webm')).toBe(true);
    expect(matchesQuery(base, '2025')).toBe(false);
  });
});

describe('files helpers', () => {
  it('mapLimit keeps order and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return value * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('copyFileAtomic copies through a partial file and refuses the original path', async () => {
    const source = path.join(dir, 'a.webm');
    const target = path.join(dir, 'copy.webm');
    fs.writeFileSync(source, 'video');
    await copyFileAtomic(source, target);
    expect(fs.readFileSync(target, 'utf8')).toBe('video');
    expect(fs.readdirSync(dir).sort()).toEqual(['a.webm', 'copy.webm']);
    await expect(copyFileAtomic(source, source.toUpperCase())).rejects.toThrow(/overwrite/);
    expect(fs.readFileSync(source, 'utf8')).toBe('video');
  });

  it('copyFileAtomic leaves nothing behind when the copy fails', async () => {
    const spy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(copyFileAtomic(path.join(dir, 'missing'), path.join(dir, 'x'))).rejects.toThrow(
      'disk full',
    );
    spy.mockRestore();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
