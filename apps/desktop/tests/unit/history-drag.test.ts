/**
 * Drag-out of a history item: the file comes from the history item (never from the renderer), and
 * anything odd (unknown id, missing file, traversal, not a FrameCapt media type) is refused before a drag can start.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planDrag } from '../../src/main/history/drag';
import { HistoryService } from '../../src/main/history/service';
import { fakeTools } from './fake-tools';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-drag-'));
});

async function setup() {
  const historyDir = path.join(root, 'history');
  const history = new HistoryService({
    dir: historyDir,
    tools: fakeTools(),
    trashItem: async () => undefined,
  });
  const add = async (name: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, 'x');
    const { id } = await history.addScreenshot({
      path: file,
      width: 1,
      height: 1,
      sizeBytes: 1,
      format: 'png',
      source: 'region',
    });
    return { id, file };
  };
  const plan = (id: string) => planDrag({ history }, id);
  return { history, add, plan };
}

describe('planDrag', () => {
  it('returns the file of a history item', async () => {
    const { add, plan } = await setup();
    const mine = await add('mine.png');
    expect(await plan(mine.id)).toEqual({ file: mine.file, icon: null });
  });

  it('refuses an unknown id', async () => {
    const { plan } = await setup();
    await expect(plan('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a file that was moved or deleted', async () => {
    const { add, plan } = await setup();
    const mine = await add('gone.png');
    fs.rmSync(mine.file);
    await expect(plan(mine.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses paths with traversal, relative paths and files that are not media', async () => {
    const item = (file: string) => ({
      get: () => ({ path: file }) as never,
      thumbPathOf: () => undefined,
    });
    const plan = (file: string) => planDrag({ history: item(file) }, 'id');
    fs.writeFileSync(path.join(root, 'ok.png'), 'x');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(root, 'run.exe'), 'x');
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    await expect(plan(`${sub}${path.sep}..${path.sep}ok.png`)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(plan('ok.png')).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(plan(path.join(root, 'notes.txt'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(plan(path.join(root, 'run.exe'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(plan(root)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});
