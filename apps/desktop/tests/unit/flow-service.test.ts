import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowFile } from '../../src/shared/flow';
import type {
  ExportDoneEvent,
  ExportFailedEvent,
  ExportProgressEvent,
} from '../../src/shared/history-ipc';
import { writeFlowFile } from '../../src/main/flows/flow-store';
import { FlowService } from '../../src/main/flows/service';
import { HistoryService } from '../../src/main/history/service';
import { JobRunner } from '../../src/main/media/job-runner';
import { FfmpegError } from '../../src/main/media/ffmpeg';
import { fakeTools, PLAYABLE, type FakeTools, type FakeToolsOptions } from './fake-tools';

const H264: typeof PLAYABLE = {
  ...PLAYABLE,
  hasAudio: false,
  video: { width: 640, height: 360, codec: 'h264', pixFmt: 'yuv420p' },
  audioCodec: null,
  durationSec: 7.5,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
};

/**
 * fakeTools, plus a slideshow "encoder": a run that reads the numbered pictures writes its output
 * (the last argument) and exits; everything else (thumbnails of a new video) is the plain fake.
 */
function slideshowTools(options: FakeToolsOptions = {}): FakeTools {
  const base = fakeTools({ probe: () => H264, ...options });
  return {
    ...base,
    async run(args, runOptions = {}) {
      if (!args.some((arg) => arg.endsWith('frame-%04d.png'))) return base.run(args, runOptions);
      base.runs.push(args);
      await options.beforeRun?.(args, runOptions);
      if (runOptions.signal?.aborted) throw new FfmpegError('FFMPEG_ABORTED', 'aborted');
      if ((options.code ?? 0) !== 0) return { code: options.code ?? 1, stderrTail: 'boom' };
      fs.writeFileSync(args.at(-1) as string, 'slides');
      return { code: 0, stderrTail: '' };
    },
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-fsvc-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Signature + IHDR only: what the magic-byte and size readers look at. */
function fakePng(width = 640, height = 360, filler = 0): Buffer {
  const bytes = Buffer.alloc(64 + filler);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const ab = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

interface Options {
  folder?: string | null;
  saveTo?: string | null;
  undoWindowMs?: number;
  tools?: FakeTools;
  mp4?: boolean;
}

function setup(options: Options = {}) {
  const shots = path.join(root, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const trashed: string[] = [];
  const thumbnails: { size: { width: number; height: number }; cursor: unknown }[] = [];
  const tools = options.tools ?? slideshowTools();
  const history = new HistoryService({
    dir: path.join(root, 'history'),
    tools,
    trashItem: (file) => {
      trashed.push(file);
      fs.rmSync(file, { recursive: true, force: true });
      return Promise.resolve();
    },
    undoWindowMs: 50,
  });
  const events = {
    progress: [] as ExportProgressEvent[],
    done: [] as ExportDoneEvent[],
    failed: [] as ExportFailedEvent[],
  };
  const runner = new JobRunner();
  const remembered: string[] = [];
  const service = new FlowService({
    history,
    tools,
    runner,
    capability: () => Promise.resolve({ available: options.mp4 ?? true }),
    screenshotsDir: () => shots,
    scratchDir: path.join(root, 'scratch'),
    thumbnail: (_png, cursor, size) => {
      thumbnails.push({ size, cursor });
      return fakePng(100);
    },
    trashItem: (file) => {
      trashed.push(file);
      fs.rmSync(file, { recursive: true, force: true });
      return Promise.resolve();
    },
    pickFolder: () =>
      Promise.resolve(options.folder === undefined ? path.join(root, 'pictures') : options.folder),
    pickSave: ({ defaultName }) => {
      // The real dialog hands back a folder that exists.
      fs.mkdirSync(path.join(root, 'out'), { recursive: true });
      return Promise.resolve(
        options.saveTo === undefined ? path.join(root, 'out', defaultName) : options.saveTo,
      );
    },
    remember: (file) => remembered.push(file),
    emit: {
      progress: (event) => events.progress.push(event),
      done: (event) => events.done.push(event),
      failed: (event) => events.failed.push(event),
    },
    undoWindowMs: options.undoWindowMs ?? 40,
  });
  return { service, history, shots, trashed, thumbnails, events, runner, remembered, tools };
}

/** A session of `count` captured steps, saved through the service. */
async function saveGuide(ctx: ReturnType<typeof setup>, count = 3) {
  const session = path.join(root, 'session');
  fs.mkdirSync(session, { recursive: true });
  const steps = Array.from({ length: count }, (_, index) => {
    const source = path.join(session, `raw-${index}.png`);
    fs.writeFileSync(source, fakePng(640 + index, 360, index * 10));
    return {
      source,
      width: 640 + index,
      height: 360,
      cursor: index === 0 ? { x: 30, y: 40 } : null,
      at: 100 + index,
    };
  });
  const { historyId } = await ctx.service.saveSession({
    steps,
    createdAt: new Date(2026, 9, 7, 14, 5, 9).getTime(),
  });
  const item = ctx.history.get(historyId);
  if (!item) throw new Error('not added');
  return { historyId, item, dir: path.dirname(item.path) };
}

const readJson = (file: string): FlowFile => JSON.parse(fs.readFileSync(file, 'utf8')) as FlowFile;

describe('saving a captured guide', () => {
  it('writes the folder and adds a flow item to History', async () => {
    const ctx = setup();
    const { item, dir } = await saveGuide(ctx);
    expect(path.basename(dir)).toBe('FrameCapt Steps 2026-10-07 at 14.05.09');
    expect(path.dirname(dir)).toBe(ctx.shots);
    expect(item).toMatchObject({
      type: 'flow',
      format: 'flow',
      source: 'screen',
      durationMs: null,
      hasAudio: null,
      derivedFrom: null,
      width: 640,
      height: 360,
      stepCount: 3,
    });
    expect(path.basename(item.path)).toBe('flow.json');
    expect(item.thumbnail).not.toBeNull();
    expect(ctx.thumbnails[0]).toMatchObject({
      cursor: { x: 30, y: 40 },
      size: { width: 640, height: 360 },
    });
    expect(ctx.remembered).toContain(item.path);
  });

  it('shows in the list with its step count, the size of all its files and the right type filter', async () => {
    const ctx = setup();
    const { historyId } = await saveGuide(ctx, 2);
    await ctx.history.addScreenshot({
      path: path.join(ctx.shots, 'shot.png'),
      width: 1,
      height: 1,
      sizeBytes: 1,
      format: 'png',
      source: 'region',
    });
    const all = await ctx.history.list({});
    const guide = all.items.find((entry) => entry.id === historyId);
    expect(guide).toMatchObject({
      type: 'flow',
      format: 'flow',
      stepCount: 2,
      exists: true,
      hasThumb: true,
      editable: false,
    });
    expect(guide?.sizeBytes).toBeGreaterThan(64 * 2);
    const onlyGuides = await ctx.history.list({ filter: 'flow' });
    expect(onlyGuides.items.map((entry) => entry.id)).toEqual([historyId]);
    const searched = await ctx.history.list({ query: 'guide' });
    expect(searched.items.map((entry) => entry.id)).toEqual([historyId]);
    expect(
      (await ctx.history.list({ filter: 'screenshot' })).items.some(
        (entry) => entry.type === 'flow',
      ),
    ).toBe(false);
  });
});

describe('reading a guide', () => {
  it('get returns the flow and one media URL per step; the route resolves them', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    const got = await ctx.service.get(historyId);
    expect(got.flow.steps).toHaveLength(3);
    expect(got.stepUrls).toHaveLength(3);
    got.stepUrls.forEach((url, index) => {
      expect(url).toMatch(
        new RegExp(`^framecapt-media://flowstep/${historyId}/${index}/[0-9a-z]+$`),
      );
    });
    expect(ctx.service.stepPathOf(historyId, 1)).toBe(path.join(dir, 'step-02.png'));
  });

  it('serves nothing for an unknown guide, an index out of range or a guide never opened', async () => {
    const ctx = setup();
    const { historyId } = await saveGuide(ctx);
    expect(ctx.service.stepPathOf(historyId, 0)).toBeUndefined(); // get() was not called yet
    await ctx.service.get(historyId);
    expect(ctx.service.stepPathOf(historyId, 3)).toBeUndefined();
    expect(ctx.service.stepPathOf('0f0e0d0c-0b0a-4908-8706-050403020100', 0)).toBeUndefined();
  });

  it('a damaged or moved flow.json is a clear NOT_FOUND', async () => {
    const ctx = setup();
    const { historyId, item } = await saveGuide(ctx);
    fs.writeFileSync(item.path, '{ nope');
    await expect(ctx.service.get(historyId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ctx.service.get('0f0e0d0c-0b0a-4908-8706-050403020100')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('editing a guide', () => {
  it('stores the title and captions in flow.json (trimmed title, caption text kept)', async () => {
    const ctx = setup();
    const { historyId, item } = await saveGuide(ctx);
    const answer = await ctx.service.update({
      historyId,
      title: '  Set up the thing  ',
      steps: [
        { file: 'step-01.png', caption: 'Open the menu' },
        { file: 'step-02.png', caption: '' },
        { file: 'step-03.png', caption: '<b>Click</b> "OK" & done' },
      ],
    });
    expect(answer.flow.title).toBe('Set up the thing');
    const saved = readJson(item.path);
    expect(saved.title).toBe('Set up the thing');
    expect(saved.steps.map((s) => s.caption)).toEqual([
      'Open the menu',
      '',
      '<b>Click</b> "OK" & done',
    ]);
    // Everything else of a step is kept as captured.
    expect(saved.steps[0]).toMatchObject({
      width: 640,
      height: 360,
      cursor: { x: 30, y: 40 },
      at: 100,
    });
  });

  it('reorders steps and refreshes the first-step thumbnail, width and height of the entry', async () => {
    const ctx = setup();
    const { historyId, item } = await saveGuide(ctx);
    expect(ctx.thumbnails).toHaveLength(1);
    await ctx.service.update({
      historyId,
      steps: [
        { file: 'step-03.png', caption: 'c' },
        { file: 'step-01.png', caption: 'a' },
        { file: 'step-02.png', caption: 'b' },
      ],
    });
    expect(readJson(item.path).steps.map((s) => s.file)).toEqual([
      'step-03.png',
      'step-01.png',
      'step-02.png',
    ]);
    expect(ctx.thumbnails).toHaveLength(2);
    expect(ctx.thumbnails[1]?.size).toEqual({ width: 642, height: 360 });
    expect(ctx.history.get(historyId)).toMatchObject({ width: 642, stepCount: 3 });
  });

  it('a caption edit does not rebuild the thumbnail', async () => {
    const ctx = setup();
    const { historyId } = await saveGuide(ctx);
    await ctx.service.update({
      historyId,
      steps: ['step-01.png', 'step-02.png', 'step-03.png'].map((file) => ({ file, caption: 'x' })),
    });
    expect(ctx.thumbnails).toHaveLength(1);
  });

  it('deleting a step removes it from flow.json at once, keeps the image for Undo, then trashes it', async () => {
    const ctx = setup({ undoWindowMs: 60 });
    const { historyId, item, dir } = await saveGuide(ctx);
    await ctx.service.update({
      historyId,
      steps: [
        { file: 'step-01.png', caption: '' },
        { file: 'step-03.png', caption: '' },
      ],
    });
    expect(readJson(item.path).steps).toHaveLength(2);
    expect(ctx.history.get(historyId)?.stepCount).toBe(2);
    expect(fs.existsSync(path.join(dir, 'step-02.png'))).toBe(true);
    // Undo: the step comes back with everything it had.
    const restored = await ctx.service.update({
      historyId,
      steps: [
        { file: 'step-01.png', caption: '' },
        { file: 'step-02.png', caption: 'back' },
        { file: 'step-03.png', caption: '' },
      ],
    });
    expect(restored.flow.steps.map((s) => s.file)).toEqual([
      'step-01.png',
      'step-02.png',
      'step-03.png',
    ]);
    expect(restored.flow.steps[1]).toMatchObject({ width: 641, caption: 'back' });
    // Delete again and let the window pass: the image goes to the Recycle Bin, never a permanent delete.
    await ctx.service.update({
      historyId,
      steps: [
        { file: 'step-01.png', caption: '' },
        { file: 'step-03.png', caption: '' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.trashed).toEqual([path.join(dir, 'step-02.png')]);
    expect(fs.existsSync(path.join(dir, 'step-02.png'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'step-01.png'))).toBe(true);
  });

  it('refuses a file name that is not in the guide, a duplicate and a vanished image', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    const base = [{ file: 'step-01.png', caption: '' }];
    for (const bad of ['step-09.png', '../step-01.png', 'flow.json', 'C:\\Windows\\win.ini']) {
      await expect(
        ctx.service.update({ historyId, steps: [...base, { file: bad, caption: '' }] }),
        bad,
      ).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
    }
    await expect(
      ctx.service.update({
        historyId,
        steps: [...base, { file: 'step-01.png', caption: 'again' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    fs.rmSync(path.join(dir, 'step-02.png'));
    await expect(
      ctx.service.update({ historyId, steps: [...base, { file: 'step-02.png', caption: '' }] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a guide whose entry is not a flow cannot be edited through this service', async () => {
    const ctx = setup();
    const shot = await ctx.history.addScreenshot({
      path: path.join(ctx.shots, 'a.png'),
      width: 1,
      height: 1,
      sizeBytes: 1,
      format: 'png',
      source: 'region',
    });
    await expect(ctx.service.get(shot.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('editing one step in the editor', () => {
  it('replaces the image atomically, keeps the pointer when the size is the same and refreshes the thumbnail of the first step', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    const edited = fakePng(640, 360, 500);
    const saved = await ctx.service.replaceStep(historyId, 0, edited);
    expect(saved.path).toBe(path.join(dir, 'step-01.png'));
    expect(fs.readFileSync(saved.path)).toEqual(edited);
    const flow = readJson(path.join(dir, 'flow.json'));
    expect(flow.steps[0]).toMatchObject({ width: 640, height: 360, cursor: { x: 30, y: 40 } });
    expect(ctx.thumbnails).toHaveLength(2);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a cropped picture updates the size and drops the pointer, which no longer fits', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    await ctx.service.replaceStep(historyId, 0, fakePng(300, 200));
    const flow = readJson(path.join(dir, 'flow.json'));
    expect(flow.steps[0]).toMatchObject({ width: 300, height: 200, cursor: null });
    expect(ctx.history.get(historyId)).toMatchObject({ width: 300, height: 200 });
  });

  it('only a PNG of an existing step is accepted', async () => {
    const ctx = setup();
    const { historyId } = await saveGuide(ctx);
    await expect(
      ctx.service.replaceStep(historyId, 0, Buffer.from('not a png')),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(ctx.service.replaceStep(historyId, 9, fakePng())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('readStep returns the PNG and its size for the editor', async () => {
    const ctx = setup();
    const { historyId } = await saveGuide(ctx);
    const step = await ctx.service.readStep(historyId, 2);
    expect(step).toMatchObject({ width: 642, height: 360 });
    expect(step.png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(ctx.service.readStep(historyId, 3)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('History actions on a guide', () => {
  it('Delete file moves the whole folder to the Recycle Bin when it holds only guide files', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    await ctx.history.deleteFile(historyId);
    expect(ctx.trashed).toEqual([dir]);
    expect(ctx.history.get(historyId)).toBeUndefined();
  });

  it('refuses to trash a folder that also holds other files, and keeps the entry', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    fs.writeFileSync(path.join(dir, 'my-notes.txt'), 'keep me');
    await expect(ctx.history.deleteFile(historyId)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    expect(ctx.trashed).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'my-notes.txt'))).toBe(true);
    expect(ctx.history.get(historyId)).toBeDefined();
  });

  it('Remove from history leaves the folder alone', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    await ctx.history.remove(historyId);
    expect(fs.existsSync(path.join(dir, 'flow.json'))).toBe(true);
  });

  it('Locate: points the entry at a moved guide, and only at a real flow.json', async () => {
    const ctx = setup();
    const { historyId, dir } = await saveGuide(ctx);
    const moved = path.join(root, 'moved', 'FrameCapt Steps 2026-10-07 at 14.05.09');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(dir, moved);
    expect((await ctx.history.list({})).items[0]?.exists).toBe(false);
    await expect(
      ctx.history.relink(historyId, path.join(moved, 'step-01.png')),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    fs.writeFileSync(path.join(root, 'flow.json'), '{"nope":1}');
    await expect(ctx.history.relink(historyId, path.join(root, 'flow.json'))).rejects.toMatchObject(
      { code: 'INVALID_PAYLOAD' },
    );
    await ctx.history.relink(historyId, path.join(moved, 'flow.json'));
    const view = (await ctx.history.list({})).items[0];
    expect(view).toMatchObject({ exists: true, stepCount: 3, type: 'flow' });
    expect(view?.path).toBe(path.join(moved, 'flow.json'));
    // The steps are read from the new place.
    expect((await ctx.service.get(historyId)).flow.steps).toHaveLength(3);
  });

  it('an old history.json (no guides) and one with a guide both load; an unknown future type stays unlisted', async () => {
    const ctx = setup();
    const { historyId } = await saveGuide(ctx);
    await ctx.history.idle();
    const file = path.join(root, 'history', 'history.json');
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { items: unknown[] };
    body.items.push({ id: '1f0e0d0c-0b0a-4908-8706-050403020100', type: 'hologram', path: 'x' });
    fs.writeFileSync(file, JSON.stringify(body));
    const reloaded = new HistoryService({
      dir: path.join(root, 'history'),
      tools: fakeTools(),
      trashItem: () => Promise.resolve(),
    });
    const { items, total } = await reloaded.list({});
    expect(items.map((item) => item.id)).toEqual([historyId]);
    expect(total).toBe(1);
    await reloaded.remove(historyId);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { items: { type: string }[] };
    expect(after.items.map((item) => item.type)).toEqual(['hologram']);
  });
});

describe('exporting a guide', () => {
  async function prepared(ctx: ReturnType<typeof setup>, captions: string[] = ['', '', '']) {
    const guide = await saveGuide(ctx, captions.length);
    await ctx.service.update({
      historyId: guide.historyId,
      title: 'My <guide> & "co"',
      steps: captions.map((caption, index) => ({ file: `step-0${index + 1}.png`, caption })),
    });
    const frames = captions.map((_, index) => ab(fakePng(64, 36, index)));
    return { ...guide, frames };
  }

  it('HTML: one self-contained page with the captions and title escaped, no script, no external address', async () => {
    const ctx = setup();
    const { historyId, frames } = await prepared(ctx, [
      '<script>alert(1)</script>',
      'Click "OK" & <b>go</b>',
      '',
    ]);
    const answer = await ctx.service.export({ historyId, kind: 'html', frames });
    const out = 'path' in answer ? answer.path : '';
    // The suggested name is a safe file name made from the title.
    expect(out).toBe(path.join(root, 'out', 'My guide & co.html'));
    const html = fs.readFileSync(out, 'utf8');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Click &quot;OK&quot; &amp; &lt;b&gt;go&lt;/b&gt;');
    expect(html).toContain('<title>My &lt;guide&gt; &amp; &quot;co&quot;</title>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\s(src|href)="(?!data:image\/png;base64,)/i);
    expect(html).toContain('Content-Security-Policy');
    expect(html.match(/<img /g)).toHaveLength(3);
    expect(ctx.remembered).toContain(out);
  });

  it('HTML: a cancelled dialog writes nothing', async () => {
    const ctx = setup({ saveTo: null });
    const { historyId, frames } = await prepared(ctx);
    expect(await ctx.service.export({ historyId, kind: 'html', frames })).toEqual({
      cancelled: true,
    });
    expect(fs.readdirSync(path.join(root, 'out'))).toEqual([]);
  });

  it('Images: numbered PNGs into the chosen folder, never overwriting', async () => {
    const pictures = path.join(root, 'pictures');
    fs.mkdirSync(pictures);
    fs.writeFileSync(path.join(pictures, 'step-01.png'), 'mine');
    const ctx = setup({ folder: pictures });
    const { historyId, frames } = await prepared(ctx);
    const answer = await ctx.service.export({ historyId, kind: 'images', frames });
    expect(answer).toHaveProperty('path');
    expect(fs.readFileSync(path.join(pictures, 'step-01.png'), 'utf8')).toBe('mine');
    expect(fs.readdirSync(pictures).sort()).toEqual([
      'step-01 (2).png',
      'step-01.png',
      'step-02.png',
      'step-03.png',
    ]);
  });

  it('refuses pictures that do not match the steps or are not PNG', async () => {
    const ctx = setup();
    const { historyId, frames } = await prepared(ctx);
    await expect(
      ctx.service.export({ historyId, kind: 'html', frames: frames.slice(1) }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    const bad = [...frames];
    bad[1] = ab(Buffer.from('<html>'));
    await expect(
      ctx.service.export({ historyId, kind: 'images', frames: bad }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('MP4: a job on the shared runner writes a verified file, adds it to History as derived from the guide', async () => {
    const ctx = setup();
    const { historyId, frames } = await prepared(ctx);
    const answer = await ctx.service.export({ historyId, kind: 'mp4', frames });
    expect(answer).toHaveProperty('jobId');
    await ctx.runner.idle();
    expect(ctx.events.failed).toEqual([]);
    expect(ctx.events.done).toHaveLength(1);
    expect(ctx.events.done[0]).toMatchObject({
      kind: 'guide',
      historyId,
      path: path.join(root, 'out', 'My guide & co.mp4'),
    });
    const out = ctx.events.done[0]?.path ?? '';
    expect(fs.existsSync(out)).toBe(true);
    const itemId = ctx.events.done[0]?.itemId;
    expect(itemId).toBeTruthy();
    expect(ctx.history.get(itemId ?? '')).toMatchObject({
      type: 'recording',
      format: 'mp4',
      derivedFrom: historyId,
      hasAudio: false,
      durationMs: 7500,
    });
    // No scratch pictures or partial files are left behind.
    expect(fs.readdirSync(path.join(root, 'scratch'))).toEqual([]);
    expect(
      fs.readdirSync(path.join(root, 'out')).filter((name) => name.includes('partial')),
    ).toEqual([]);
  });

  it('MP4: refused up front when this build cannot encode H.264', async () => {
    const ctx = setup({ mp4: false });
    const { historyId, frames } = await prepared(ctx);
    await expect(ctx.service.export({ historyId, kind: 'mp4', frames })).rejects.toMatchObject({
      code: 'FFMPEG_MISSING',
    });
    expect(await ctx.service.export({ historyId, kind: 'gif', frames })).toHaveProperty('jobId');
    await ctx.runner.idle();
  });

  it('GIF: a job that adds a GIF to History as derived from the guide, with a done event carrying the path', async () => {
    const ctx = setup();
    const { historyId, frames } = await prepared(ctx);
    await ctx.service.export({ historyId, kind: 'gif', frames });
    await ctx.runner.idle();
    expect(ctx.events.done[0]).toMatchObject({ kind: 'guide' });
    expect(ctx.events.done[0]?.path.endsWith('.gif')).toBe(true);
    const itemId = ctx.events.done[0]?.itemId;
    expect(itemId).toBeTruthy();
    expect(ctx.history.get(itemId ?? '')).toMatchObject({
      type: 'recording',
      format: 'gif',
      derivedFrom: historyId,
    });
    expect(ctx.remembered).toContain(ctx.events.done[0]?.path);
  });

  it('a failing encoder reports a failed event and leaves nothing behind', async () => {
    const ctx = setup({ tools: slideshowTools({ code: 1 }) });
    const { historyId, frames } = await prepared(ctx);
    await ctx.service.export({ historyId, kind: 'mp4', frames });
    await ctx.runner.idle();
    expect(ctx.events.done).toEqual([]);
    expect(ctx.events.failed[0]).toMatchObject({ kind: 'guide', cancelled: false, code: 'FAILED' });
    expect(fs.existsSync(path.join(root, 'out', 'My guide & co.mp4'))).toBe(false);
  });

  it('cancelling the job aborts the encoder and reports a cancelled export', async () => {
    const started = vi.fn();
    const tools = slideshowTools({
      beforeRun: async (_args, options) => {
        started();
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve()),
        );
      },
    });
    const ctx = setup({ tools });
    const { historyId, frames } = await prepared(ctx);
    const answer = await ctx.service.export({ historyId, kind: 'mp4', frames });
    const jobId = 'jobId' in answer ? answer.jobId : '';
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(ctx.runner.cancel(jobId)).toBe(true);
    await ctx.runner.idle();
    expect(ctx.events.failed[0]).toMatchObject({ cancelled: true, code: 'CANCELLED' });
  });
});

describe('writeFlowFile through the service keeps the file valid for a rescan', () => {
  it('flow.json written by the service parses back with the schema', async () => {
    const ctx = setup();
    const { item } = await saveGuide(ctx);
    const again = path.join(root, 'copy.json');
    await writeFlowFile(again, readJson(item.path));
    expect(readJson(again).steps).toHaveLength(3);
  });
});
