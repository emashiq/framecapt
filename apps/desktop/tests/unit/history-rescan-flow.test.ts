import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryService } from '../../src/main/history/service';
import { rescanLibrary } from '../../src/main/history/rescan';
import { writeFlowFile } from '../../src/main/flows/flow-store';
import { flowFolderName, type FlowFile } from '../../src/shared/flow';
import { fakeTools } from './fake-tools';

let root: string;
let shots: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-rescan-flow-'));
  shots = path.join(root, 'shots');
  fs.mkdirSync(shots);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakePng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function makeGuide(parent: string, name: string, steps = 2): Promise<string> {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const flow: FlowFile = {
    version: 1,
    createdAt: 1,
    steps: Array.from({ length: steps }, (_, index) => ({
      file: `step-0${index + 1}.png`,
      width: 800,
      height: 450,
      cursor: { x: 10, y: 10 },
      caption: '',
      at: index,
    })),
  };
  for (const step of flow.steps) fs.writeFileSync(path.join(dir, step.file), fakePng(800, 450));
  await writeFlowFile(path.join(dir, 'flow.json'), flow);
  return dir;
}

function setup() {
  const tools = fakeTools();
  const history = new HistoryService({
    dir: path.join(root, 'history'),
    tools,
    trashItem: () => Promise.resolve(),
  });
  const thumbed: string[] = [];
  const run = () =>
    rescanLibrary({
      dirs: [shots],
      history,
      tools,
      thumbnail: () => Promise.resolve(undefined),
      flowThumbnail: (dir) => {
        thumbed.push(dir);
        return Promise.resolve(fakePng(100, 56));
      },
    });
  return { history, run, thumbed };
}

describe('rescan of step guide folders', () => {
  it('adds a FrameCapt Steps folder that holds a valid flow.json, one level deep', async () => {
    const name = flowFolderName(new Date(2026, 9, 2, 14, 5, 9));
    const dir = await makeGuide(shots, name, 3);
    const { history, run, thumbed } = setup();
    expect(await run()).toBe(1);
    const [item] = (await history.list({})).items;
    expect(item).toMatchObject({
      type: 'flow',
      format: 'flow',
      stepCount: 3,
      width: 800,
      height: 450,
      exists: true,
      hasThumb: true,
    });
    expect(item?.path).toBe(path.join(dir, 'flow.json'));
    // A guide is named by its folder, not "flow.json" (every guide would look the same).
    expect(item?.fileName).toBe(name);
    expect(item?.createdAt).toBe(new Date(2026, 9, 2, 14, 5, 9).getTime());
    expect(thumbed).toEqual([dir]);
  });

  it('is idempotent: a second scan adds nothing, and a moved copy is found only once', async () => {
    await makeGuide(shots, flowFolderName(new Date(2026, 9, 2, 14, 5, 9)));
    const { run } = setup();
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
  });

  it('ignores folders with other names, invalid or missing flow.json and nesting beyond 8 levels', async () => {
    await makeGuide(shots, 'My holiday steps');
    const tooDeep = path.join(shots, ...'abcdefghi'.split(''));
    await makeGuide(tooDeep, flowFolderName(new Date(2026, 9, 2, 14, 5, 9)));
    const broken = path.join(shots, flowFolderName(new Date(2026, 9, 2, 14, 5, 10)));
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'flow.json'), '{ nope');
    fs.mkdirSync(path.join(shots, flowFolderName(new Date(2026, 9, 2, 14, 5, 11))));
    const { run } = setup();
    expect(await run()).toBe(0);
  });

  it('finds a guide inside a library folder', async () => {
    await makeGuide(
      path.join(shots, 'Clients', 'Acme'),
      flowFolderName(new Date(2026, 9, 2, 14, 5, 9)),
    );
    const { history, run } = setup();
    expect(await run()).toBe(1);
    expect((await history.list({})).items[0]).toMatchObject({ type: 'flow' });
  });

  it('still finds ordinary screenshots next to guides', async () => {
    await makeGuide(shots, flowFolderName(new Date(2026, 9, 2, 14, 5, 9)));
    fs.writeFileSync(path.join(shots, 'FrameCapt 2026-10-02 at 14.05.12.png'), fakePng(10, 10));
    const { history, run } = setup();
    expect(await run()).toBe(2);
    expect((await history.list({})).items.map((item) => item.type).sort()).toEqual([
      'flow',
      'screenshot',
    ]);
  });
});
