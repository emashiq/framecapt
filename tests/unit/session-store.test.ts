import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowState } from '../../src/main/shots/flow-state';
import { isInsideDir, KEEP_MARKER, ShotSessionStore } from '../../src/main/shots/session-store';
import { writeFileAtomic } from '../../src/main/shots/atomic-write';

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-shots-'));
  root = path.join(tmp, 'shots');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('isInsideDir', () => {
  it('accepts the directory itself and children', () => {
    expect(isInsideDir('/a/shots', '/a/shots')).toBe(true);
    expect(isInsideDir('/a/shots', '/a/shots/x/original.png')).toBe(true);
  });

  it('rejects siblings, parents and ../ escapes', () => {
    expect(isInsideDir('/a/shots', '/a/shots-evil/x')).toBe(false);
    expect(isInsideDir('/a/shots', '/a')).toBe(false);
    expect(isInsideDir('/a/shots', '/a/shots/../secrets')).toBe(false);
    expect(isInsideDir('/a/shots', '/a/shots/x/../../secrets')).toBe(false);
  });
});

describe('ShotSessionStore', () => {
  it('writes the original under the shots root and exposes only metadata', async () => {
    const store = new ShotSessionStore(root, () => 1234);
    const session = await store.create({ kind: 'region', width: 400, height: 300, png });
    expect(isInsideDir(root, session.originalPath)).toBe(true);
    expect(path.basename(session.originalPath)).toBe('original.png');
    expect(fs.readFileSync(session.originalPath)).toEqual(png);
    expect(store.meta(session)).toEqual({
      id: session.id,
      kind: 'region',
      width: 400,
      height: 300,
      createdAt: 1234,
    });
    expect(JSON.stringify(store.meta(session))).not.toContain('original');
    expect(await store.readOriginal(session.id)).toEqual(png);
  });

  it('discard removes only the session directory', async () => {
    const store = new ShotSessionStore(root);
    const a = await store.create({ kind: 'screen', width: 1, height: 1, png });
    const b = await store.create({ kind: 'screen', width: 1, height: 1, png });
    expect(await store.discard(a.id)).toBe(true);
    expect(fs.existsSync(path.dirname(a.originalPath))).toBe(false);
    expect(fs.existsSync(b.originalPath)).toBe(true);
    expect(store.get(a.id)).toBeUndefined();
    expect(await store.discard(a.id)).toBe(false); // idempotent
  });

  it('refuses ids that are not plain session ids (path escapes)', async () => {
    const store = new ShotSessionStore(root);
    const victim = path.join(tmp, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'important.txt'), 'x');
    for (const id of ['../victim', '..', '.', '', root, 'a/b', '..\\victim']) {
      expect(store.dirFor(id)).toBeNull();
      expect(await store.discard(id)).toBe(false);
    }
    expect(fs.existsSync(path.join(victim, 'important.txt'))).toBe(true);
  });

  it('sweeps old directories without a keep marker and leaves the rest', async () => {
    let now = 10_000_000_000;
    const store = new ShotSessionStore(root, () => now);
    const old = await store.create({ kind: 'screen', width: 1, height: 1, png });
    const kept = await store.create({ kind: 'screen', width: 1, height: 1, png });
    const fresh = await store.create({ kind: 'screen', width: 1, height: 1, png });
    fs.writeFileSync(path.join(path.dirname(kept.originalPath), KEEP_MARKER), '');
    fs.mkdirSync(path.join(root, 'not-a-session')); // foreign directory is never touched

    const day = 24 * 60 * 60 * 1000;
    const longAgo = new Date(now - 8 * day);
    for (const session of [old, kept])
      fs.utimesSync(path.dirname(session.originalPath), longAgo, longAgo);
    const recent = new Date(now - 2 * day);
    fs.utimesSync(path.dirname(fresh.originalPath), recent, recent);
    now += 1;

    const result = await store.sweep(7 * day);
    expect(result).toEqual({ scanned: 3, removed: 1, kept: 2 });
    expect(fs.existsSync(path.dirname(old.originalPath))).toBe(false);
    expect(fs.existsSync(kept.originalPath)).toBe(true);
    expect(fs.existsSync(fresh.originalPath)).toBe(true);
    expect(fs.existsSync(path.join(root, 'not-a-session'))).toBe(true);
  });

  it('sweep on a missing directory is a no-op', async () => {
    expect(await new ShotSessionStore(path.join(tmp, 'nope')).sweep()).toEqual({
      scanned: 0,
      removed: 0,
      kept: 0,
    });
  });
});

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp files', async () => {
    const target = path.join(tmp, 'out.png');
    await writeFileAtomic(target, png);
    expect(fs.readFileSync(target)).toEqual(png);
    expect(fs.readdirSync(tmp).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing file', async () => {
    const target = path.join(tmp, 'out.png');
    fs.writeFileSync(target, 'old');
    await writeFileAtomic(target, png);
    expect(fs.readFileSync(target)).toEqual(png);
  });

  it('cleans up and rethrows when the directory does not exist', async () => {
    await expect(writeFileAtomic(path.join(tmp, 'missing', 'out.png'), png)).rejects.toThrow();
  });
});

describe('FlowState', () => {
  it('allows one flow at a time and reports BUSY', () => {
    const state = new FlowState();
    const first = state.tryStart();
    expect(first.ok).toBe(true);
    expect(state.tryStart()).toEqual({ ok: false, code: 'BUSY' });
    expect(state.active).toBe(true);
  });

  it('end is idempotent and frees the flow', () => {
    const state = new FlowState();
    const first = state.tryStart();
    if (!first.ok) throw new Error('expected a flow');
    expect(state.end(first.flowId)).toBe(true);
    expect(state.end(first.flowId)).toBe(false);
    expect(state.phase).toBe('idle');
    expect(state.tryStart().ok).toBe(true);
  });

  it('a stale flow id can neither end nor advance a newer flow', () => {
    const state = new FlowState();
    const a = state.tryStart();
    if (!a.ok) throw new Error('expected a flow');
    state.end(a.flowId);
    const b = state.tryStart();
    if (!b.ok) throw new Error('expected a flow');
    expect(state.isCurrent(a.flowId)).toBe(false);
    expect(state.setPhase(a.flowId, 'selecting')).toBe(false);
    expect(state.end(a.flowId)).toBe(false);
    expect(state.active).toBe(true);
    expect(state.setPhase(b.flowId, 'selecting')).toBe(true);
    expect(state.phase).toBe('selecting');
  });
});

describe('ShotSessionStore: links', () => {
  it('sweep never follows a symlink or junction named like a session directory', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep-me.txt'), 'precious');
    fs.mkdirSync(root, { recursive: true });
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    fs.symlinkSync(outside, path.join(root, id), 'junction');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(outside, old, old);

    const store = new ShotSessionStore(root);
    const result = await store.sweep(1000);
    expect(result.removed).toBe(0);
    expect(fs.readFileSync(path.join(outside, 'keep-me.txt'), 'utf8')).toBe('precious');
  });
});
