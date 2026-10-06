/**
 * "Save copies" (bulk export): only history items, collision-safe names, nothing overwritten, a
 * cancel keeps what was copied.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BulkExportService } from '../../src/main/history/bulk-export';
import { HistoryService } from '../../src/main/history/service';
import type { BulkExportDone } from '../../src/shared/history-ipc';
import { fakeTools } from './fake-tools';

const GHOST = '00000000-0000-4000-8000-000000000000';

let root: string;
let target: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-bulk-'));
  target = path.join(root, 'target');
  fs.mkdirSync(target);
});

async function setup(
  pick: () => Promise<string | null> = async () => target,
  afterProgress: () => void = () => undefined,
) {
  const historyDir = path.join(root, 'history');
  const history = new HistoryService({
    dir: historyDir,
    tools: fakeTools(),
    trashItem: async () => undefined,
  });
  const progress: [number, number][] = [];
  const bulk = new BulkExportService({
    history,
    pickFolder: pick,
    writable: async () => true,
    onProgress: (done, total) => {
      progress.push([done, total]);
      afterProgress();
    },
  });
  const add = async (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, `data of ${path.basename(dir)}`);
    const { id } = await history.addScreenshot({
      path: file,
      width: 1,
      height: 1,
      sizeBytes: 5,
      format: 'png',
      source: 'region',
    });
    return { id, file };
  };
  const run = async (ids: string[]): Promise<BulkExportDone> =>
    (await bulk.run(ids)) as BulkExportDone;
  return { bulk, add, run, progress };
}

describe('bulk export', () => {
  it('copies history items and gives equal names a free name, never overwriting', async () => {
    const { add, run, progress } = await setup();
    const a = await add(path.join(root, 'one'), 'shot.png');
    const b = await add(path.join(root, 'two'), 'shot.png');
    fs.writeFileSync(path.join(target, 'shot.png'), 'precious');
    const result = await run([a.id, b.id]);
    expect(result).toMatchObject({ folder: target, cancelled: false });
    expect(result.results.map((r) => [r.status, r.fileName])).toEqual([
      ['saved', 'shot (2).png'],
      ['saved', 'shot (3).png'],
    ]);
    expect(fs.readFileSync(path.join(target, 'shot.png'), 'utf8')).toBe('precious');
    expect(fs.readFileSync(path.join(target, 'shot (2).png'), 'utf8')).toBe('data of one');
    expect(fs.readFileSync(path.join(target, 'shot (3).png'), 'utf8')).toBe('data of two');
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('saving into the folder of the original keeps the original, and a repeated id is copied once', async () => {
    const { add, run } = await setup();
    const a = await add(target, 'shot.png');
    const result = await run([a.id, a.id]);
    expect(result.results.map((r) => r.fileName)).toEqual(['shot (2).png']);
    expect(fs.readFileSync(a.file, 'utf8')).toBe('data of target');
  });

  it('fails unknown ids, without touching the folder', async () => {
    const { run } = await setup();
    const result = await run([GHOST]);
    expect(result.results.map((r) => r.status)).toEqual(['failed']);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('a missing file fails that item only', async () => {
    const { add, run } = await setup();
    const gone = await add(path.join(root, 'x'), 'gone.png');
    const ok = await add(path.join(root, 'y'), 'ok.png');
    fs.rmSync(gone.file);
    const result = await run([gone.id, ok.id]);
    expect(result.results.map((r) => r.status)).toEqual(['failed', 'saved']);
  });

  it('cancelling the folder dialog does nothing', async () => {
    const { bulk } = await setup(async () => null);
    expect(await bulk.run([GHOST])).toEqual({ cancelled: true });
  });

  it('cancel keeps the copies made', async () => {
    let cancel = () => undefined as void;
    const { bulk, add, run } = await setup(
      async () => target,
      () => cancel(),
    );
    cancel = () => bulk.cancel();
    const a = await add(path.join(root, 'c1'), 'a.png');
    const b = await add(path.join(root, 'c2'), 'b.png');
    const result = await run([a.id, b.id]);
    expect(result.cancelled).toBe(true);
    expect(result.results.map((r) => r.status)).toEqual(['saved', 'skipped']);
    expect(fs.readdirSync(target)).toEqual(['a.png']);
  });
});
