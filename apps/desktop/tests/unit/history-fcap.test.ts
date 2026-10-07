/**
 * `.fcap` items in history: adding, listing (with the picture layout from the header), thumbnails
 * and relinking through `mediaInputArgs`, rescan, and what must NOT happen to them (shell open,
 * MP4 export, compression). Plus the extract service and the ffmpeg arguments it builds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinalizeService } from '../../src/main/history/finalize-service';
import { ExportService } from '../../src/main/history/export-service';
import { ExtractService } from '../../src/main/history/extract-service';
import { isOpenableMedia } from '../../src/main/history/files';
import { rescanLibrary } from '../../src/main/history/rescan';
import { HistoryService } from '../../src/main/history/service';
import { extractArgs, verifyExtract } from '../../src/main/media/extract';
import { mediaInputArgs, probeArgs, thumbnailArgs } from '../../src/main/media/ffmpeg';
import { JobRunner } from '../../src/main/media/job-runner';
import { buildFcapHeaderBlock, type FcapMeta } from '../../src/main/recording/fcap';
import { CompletionRecordSchema } from '../../src/main/recording/manifest';
import { ExtractFcapRequestSchema } from '../../src/shared/history-ipc';
import { defaultRecordingFileName } from '../../src/shared/recording';
import { fakeTools, PLAYABLE } from './fake-tools';

const META: FcapMeta = {
  width: 3840,
  height: 1080,
  durationMs: 12_000,
  hasAudio: true,
  createdAt: 1,
  sources: [
    { name: 'Screen 1', kind: 'screen', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
    { name: 'Window 2', kind: 'window', rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ],
};
const PAYLOAD = Buffer.from('webm-payload-bytes'.repeat(20));

let dir: string;
let files: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-hfcap-'));
  files = path.join(dir, 'files');
  fs.mkdirSync(files);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeFcapFile(name: string, meta: FcapMeta = META): string {
  const file = path.join(files, name);
  fs.writeFileSync(file, Buffer.concat([buildFcapHeaderBlock(meta, PAYLOAD.length), PAYLOAD]));
  return file;
}

function service(tools = fakeTools()) {
  const history = new HistoryService({
    dir: path.join(dir, 'history'),
    tools,
    trashItem: () => Promise.resolve(),
    undoWindowMs: 50,
  });
  return { history, tools };
}

async function addFcap(history: HistoryService, name = 'a.fcap', file = writeFcapFile(name)) {
  return history.addVideo({
    path: file,
    format: 'fcap',
    durationMs: 12_000,
    width: 3840,
    height: 1080,
    sizeBytes: fs.statSync(file).size,
    hasAudio: true,
    source: 'multi',
  });
}

describe('adding and listing', () => {
  it('addVideo takes fcap; the list says multi and carries the layout from the header', async () => {
    const { history } = service();
    const { id } = await addFcap(history);
    await history.idle();
    const { items } = await history.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id,
      type: 'recording',
      format: 'fcap',
      source: 'multi',
      width: 3840,
      exists: true,
      editable: false,
    });
    expect(items[0]?.layout?.sources.map((source) => source.name)).toEqual([
      'Screen 1',
      'Window 2',
    ]);
    expect(items[0]?.layout).toMatchObject({ width: 3840, height: 1080 });
  });

  it('a damaged or missing file has no layout (the entry stays, the details say so)', async () => {
    const { history } = service();
    const bad = path.join(files, 'bad.fcap');
    fs.writeFileSync(bad, 'not an fcap');
    await addFcap(history, 'bad.fcap', bad);
    const { items } = await history.list();
    expect(items[0]?.layout).toBeNull();
    fs.rmSync(bad);
    expect((await history.list()).items[0]).toMatchObject({ exists: false, layout: null });
  });

  it('other formats carry no layout field', async () => {
    const { history } = service();
    const webm = path.join(files, 'r.webm');
    fs.writeFileSync(webm, 'x');
    await history.addVideo({
      path: webm,
      format: 'webm',
      durationMs: 1000,
      width: 10,
      height: 10,
      sizeBytes: 1,
      hasAudio: false,
      source: 'screen',
    });
    expect((await history.list()).items[0]).not.toHaveProperty('layout');
  });

  it('the thumbnail is made from the fcap payload through the input helper', async () => {
    const { history, tools } = service();
    const file = writeFcapFile('t.fcap');
    await addFcap(history, 't.fcap', file);
    await history.idle();
    const args = tools.runs[0] as string[];
    expect(args).toEqual(expect.arrayContaining(['-skip_initial_bytes', '4096', '-f', 'matroska']));
    expect(args[args.indexOf('-i') + 1]).toBe(file);
    expect((await history.list()).items[0]?.hasThumb).toBe(true);
  });

  it('backfilling from completion records adds an .fcap as fcap', async () => {
    const { history } = service();
    const file = writeFcapFile('FrameCapt 2026-10-07 at 10.00.00.fcap');
    const completed = path.join(dir, 'recordings', 'completed');
    fs.mkdirSync(completed, { recursive: true });
    const record = CompletionRecordSchema.parse({
      sessionId: '0f0e0d0c-0b0a-4908-8706-050403020100',
      completedAt: 5,
      createdAt: 4,
      outputPath: file,
      durationMs: 12_000,
      bytes: 100,
      width: 3840,
      height: 1080,
      source: { kind: 'multi' },
      hasAudio: true,
      mime: 'video/webm',
      recovered: false,
      unindexed: false,
      pausedIntervals: [],
      stats: {
        queueHighWaterChunks: 0,
        queueHighWaterBytes: 0,
        mainQueueHighWater: 0,
        maxWriteMs: 0,
      },
    });
    fs.writeFileSync(path.join(completed, `${record.sessionId}.json`), JSON.stringify(record));
    expect(await history.backfillFromCompleted(path.join(dir, 'recordings'))).toBe(1);
    expect((await history.list()).items[0]).toMatchObject({ format: 'fcap', source: 'multi' });
  });
});

describe('relinking an fcap', () => {
  it('needs the .fcap extension and a valid header, then the payload is probed as Matroska', async () => {
    const { history, tools } = service();
    const { id } = await addFcap(history);
    await history.idle();
    await expect(history.relink(id, path.join(files, 'x.webm'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const notFcap = path.join(files, 'foreign.fcap');
    fs.writeFileSync(notFcap, 'plain text');
    await expect(history.relink(id, notFcap)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    const webm = path.join(files, 'moved.webm');
    fs.writeFileSync(webm, 'x');
    await expect(history.relink(id, webm)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });

    const moved = writeFcapFile('moved.fcap');
    tools.probes.length = 0;
    await history.relink(id, moved);
    expect(tools.probes).toEqual([moved]);
    expect((await history.list()).items[0]).toMatchObject({ path: moved, exists: true });
  });
});

describe('rescan', () => {
  it('adds an .fcap from its header (no ffprobe), as a multi recording', async () => {
    const out = path.join(dir, 'videos');
    fs.mkdirSync(out);
    const name = defaultRecordingFileName(new Date(2026, 9, 7, 10, 0, 0), 'fcap');
    fs.writeFileSync(
      path.join(out, name),
      Buffer.concat([buildFcapHeaderBlock(META, PAYLOAD.length), PAYLOAD]),
    );
    // A broken one with a valid name is skipped.
    fs.writeFileSync(
      path.join(out, defaultRecordingFileName(new Date(2026, 9, 7, 10, 0, 1), 'fcap')),
      'broken',
    );
    const tools = fakeTools();
    const { history } = service(tools);
    const added = await rescanLibrary({
      dirs: [out],
      history,
      tools,
      thumbnail: () => Promise.resolve(undefined),
    });
    expect(added).toBe(1);
    expect(tools.probes).toEqual([]);
    const { items } = await history.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      format: 'fcap',
      source: 'multi',
      durationMs: 12_000,
      width: 3840,
      height: 1080,
      hasAudio: true,
    });
  });
});

describe('what an fcap is never given', () => {
  it('the shell never opens it (it plays only in FrameCapt)', () => {
    expect(isOpenableMedia('C:\\v\\a.fcap')).toBe(false);
    expect(isOpenableMedia('C:\\v\\a.webm')).toBe(true);
    expect(isOpenableMedia('C:\\v\\a.mkv')).toBe(true);
  });

  it('MP4 export, save format and Save as… skip it', async () => {
    const { history } = service();
    const { id } = await addFcap(history);
    const runner = new JobRunner();
    const exports = new ExportService({
      history,
      tools: fakeTools(),
      capability: async () => ({ available: true }),
      pickDestination: async () => path.join(files, 'x.mp4'),
      emit: { progress: vi.fn(), done: vi.fn(), failed: vi.fn() },
      runner,
    });
    await expect(exports.start(id)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    const finalize = new FinalizeService({
      history,
      tools: fakeTools(),
      encoders: async () => ({ h264: true, vp9: true, gif: true }),
      settings: () => ({ saveFormat: 'mp4', compression: 'balanced' }),
      destination: async () => path.join(files, 'x.mp4'),
      trashItem: vi.fn(),
      runner,
      emit: { progress: vi.fn(), done: vi.fn(), failed: vi.fn() },
    });
    await finalize.startAfterSave(id);
    expect(runner.busy).toBe(false);
    await expect(finalize.saveAs({ id, format: 'mp4', compression: 'off' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });
});

describe('ffmpeg input helper', () => {
  it('an fcap is read as Matroska from its payload, with the file protocol only', () => {
    expect(mediaInputArgs({ path: '/a/b.fcap', format: 'fcap' })).toEqual([
      '-protocol_whitelist',
      'file',
      '-skip_initial_bytes',
      '4096',
      '-f',
      'matroska',
      '-i',
      '/a/b.fcap',
    ]);
    // Anything else is the plain local input.
    expect(mediaInputArgs({ path: '/a/b.webm', format: 'webm' })).toEqual([
      '-protocol_whitelist',
      'file',
      '-i',
      '/a/b.webm',
    ]);
    expect(mediaInputArgs({ path: '/a/b.mp4' })).toEqual([
      '-protocol_whitelist',
      'file',
      '-i',
      '/a/b.mp4',
    ]);
  });

  it('relative paths and paths that look like options are refused', () => {
    for (const bad of ['b.fcap', '-i', '--help', './x.fcap']) {
      expect(() => mediaInputArgs({ path: bad, format: 'fcap' }), bad).toThrow();
    }
  });

  it('probe and thumbnail use it for an fcap and are unchanged for others', () => {
    const probe = probeArgs('/a/b.fcap', 'fcap');
    expect(probe).toEqual(expect.arrayContaining(['-skip_initial_bytes', '4096']));
    expect(probe.at(-1)).toBe('/a/b.fcap');
    expect(probe.indexOf('-protocol_whitelist')).toBeLessThan(probe.indexOf('-i'));
    expect(probeArgs('/a/b.webm')).not.toContain('-skip_initial_bytes');
    const thumb = thumbnailArgs('/a/b.fcap', '/t.png', 1, 480, 'fcap');
    expect(thumb.indexOf('-ss')).toBeLessThan(thumb.indexOf('-skip_initial_bytes'));
    expect(thumbnailArgs('/a/b.webm', '/t.png', 1, 480)).not.toContain('-skip_initial_bytes');
  });
});

describe('extract arguments and checks', () => {
  const spec = {
    input: { path: '/a/b.fcap', format: 'fcap' },
    startMs: 1500,
    endMs: 4000,
    crop: { x: 1920, y: 0, width: 1920, height: 1080 },
    format: 'mp4' as const,
  };

  it('seeks the payload, cuts a length, crops and makes the sides even', () => {
    const args = extractArgs(spec, '/out.partial.mp4');
    expect(args[args.indexOf('-ss') + 1]).toBe('1.500');
    expect(args[args.indexOf('-t') + 1]).toBe('2.500');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'crop=1920:1080:1920:0,scale=trunc(iw/2)*2:trunc(ih/2)*2',
    );
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac', '+faststart']));
    expect(args.at(-1)).toBe('/out.partial.mp4');
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
  });

  it('the whole picture is not cropped; WebM is VP9 and Opus', () => {
    const args = extractArgs({ ...spec, crop: null, format: 'webm' }, '/o.partial.webm');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    expect(args).toEqual(expect.arrayContaining(['libvpx-vp9', 'libopus']));
    expect(args).not.toContain('+faststart');
  });

  it('verifyExtract checks container, codec, size, audio and length', () => {
    const want = { format: 'mp4' as const, width: 1920, height: 1080, durationSec: 2.5 };
    const good = {
      ...PLAYABLE,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      video: { width: 1920, height: 1080, codec: 'h264', pixFmt: 'yuv420p' },
      durationSec: 2.6,
    };
    expect(verifyExtract(good, PLAYABLE, want)).toBeNull();
    expect(verifyExtract({ ...good, formatName: 'matroska,webm' }, PLAYABLE, want)).toMatch(/MP4/);
    expect(
      verifyExtract({ ...good, video: { ...good.video, width: 1918 } }, PLAYABLE, want),
    ).toMatch(/size/);
    expect(verifyExtract({ ...good, hasAudio: false }, PLAYABLE, want)).toMatch(/audio/);
    expect(verifyExtract({ ...good, durationSec: 9 }, PLAYABLE, want)).toMatch(/length/);
    expect(verifyExtract({ ...good, durationSec: null }, PLAYABLE, want)).toMatch(/duration/);
  });

  it('the IPC request is strict and bounded', () => {
    const base = {
      id: '4a4b4c4d-4e4f-4a4b-8c4d-4e4f4a4b4c4d',
      sourceIndex: 1,
      startMs: 0,
      endMs: 1000,
      format: 'mp4',
    };
    expect(ExtractFcapRequestSchema.safeParse(base).success).toBe(true);
    expect(ExtractFcapRequestSchema.safeParse({ ...base, sourceIndex: null }).success).toBe(true);
    for (const patch of [
      { sourceIndex: 4 },
      { sourceIndex: -1 },
      { sourceIndex: 1.5 },
      { startMs: -1 },
      { endMs: 0 },
      { startMs: 1000, endMs: 1000 },
      { startMs: 2000, endMs: 1000 },
      { format: 'gif' },
      { id: '../x' },
      { path: 'C:\\x.mp4' },
    ]) {
      expect(
        ExtractFcapRequestSchema.safeParse({ ...base, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

describe('ExtractService', () => {
  function make(extract = vi.fn(), tools = fakeTools()) {
    const { history } = service(tools);
    const emit = { progress: vi.fn(), done: vi.fn(), failed: vi.fn() };
    const runner = new JobRunner();
    const extracts = new ExtractService({
      history,
      tools,
      capability: async () => ({ available: true }),
      runner,
      emit,
      extract: extract as never,
    });
    return { history, extracts, emit, runner, extract };
  }
  const ok = (dest: string) => ({
    ok: true as const,
    path: dest,
    bytes: 10,
    durationMs: 2500,
    probe: { ...PLAYABLE, video: { width: 1920, height: 1080, codec: 'h264', pixFmt: 'yuv420p' } },
  });

  it('crops the chosen source, writes next to the recording and adds a derived item', async () => {
    const extract = vi.fn(async ({ destPath }: { destPath: string }) => {
      fs.writeFileSync(destPath, 'mp4');
      return ok(destPath);
    });
    const { history, extracts, emit, runner } = make(extract);
    const file = writeFcapFile('FrameCapt 2026-10-07 at 10.00.00.fcap');
    const { id } = await addFcap(history, 'x', file);
    const { jobId } = await extracts.start({
      id,
      sourceIndex: 1,
      startMs: 1000,
      endMs: 3500,
      format: 'mp4',
    });
    await runner.idle();
    const request = extract.mock.calls[0]![0] as {
      spec: { crop: unknown; startMs: number; endMs: number; input: { format: string } };
      destPath: string;
    };
    expect(request.spec).toMatchObject({
      startMs: 1000,
      endMs: 3500,
      crop: { x: 1920, y: 0, width: 1920, height: 1080 },
      input: { format: 'fcap' },
    });
    expect(request.destPath).toBe(
      path.join(files, 'FrameCapt 2026-10-07 at 10.00.00 - Window 2.mp4'),
    );
    expect(emit.done).toHaveBeenCalledTimes(1);
    const done = emit.done.mock.calls[0]![0];
    expect(done).toMatchObject({ jobId, historyId: id, kind: 'extract' });
    const item = (await history.list()).items.find((entry) => entry.id === done.itemId);
    expect(item).toMatchObject({
      format: 'mp4',
      derivedFrom: id,
      source: 'window',
      width: 1920,
      height: 1080,
    });
  });

  it('All is the whole picture; the end is clamped to the recording; names never collide', async () => {
    const extract = vi.fn(async ({ destPath }: { destPath: string }) => {
      fs.writeFileSync(destPath, 'x');
      return ok(destPath);
    });
    const { history, extracts, runner } = make(extract);
    const { id } = await addFcap(history, 'b.fcap');
    await extracts.start({ id, sourceIndex: null, startMs: 0, endMs: 999_999, format: 'webm' });
    await runner.idle();
    const first = extract.mock.calls[0]![0] as {
      spec: { crop: unknown; endMs: number };
      destPath: string;
    };
    expect(first.spec.crop).toBeNull();
    expect(first.spec.endMs).toBe(12_000);
    expect(path.basename(first.destPath)).toBe('b - All.webm');
    await extracts.start({ id, sourceIndex: null, startMs: 0, endMs: 5000, format: 'webm' });
    await runner.idle();
    expect(path.basename((extract.mock.calls[1]![0] as { destPath: string }).destPath)).toBe(
      'b - All (2).webm',
    );
  });

  it('refuses what is not an fcap, a bad source, a tiny part, a missing or damaged file', async () => {
    const { history, extracts } = make();
    const webm = path.join(files, 'r.webm');
    fs.writeFileSync(webm, 'x');
    const plain = await history.addVideo({
      path: webm,
      format: 'webm',
      durationMs: 1000,
      width: 1,
      height: 1,
      sizeBytes: 1,
      hasAudio: false,
      source: 'screen',
    });
    const { id } = await addFcap(history);
    const base = { sourceIndex: 0, startMs: 0, endMs: 2000, format: 'mp4' as const };
    await expect(extracts.start({ ...base, id: plain.id })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(
      extracts.start({ ...base, id: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(extracts.start({ ...base, id, sourceIndex: 3 })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(extracts.start({ ...base, id, startMs: 1000, endMs: 1050 })).rejects.toMatchObject(
      { code: 'INVALID_PAYLOAD' },
    );
    // A file that went bad after it was listed.
    const bad = writeFcapFile('bad.fcap');
    fs.writeFileSync(bad, 'broken');
    const broken = await addFcap(history, 'bad.fcap', bad);
    await expect(extracts.start({ ...base, id: broken.id })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    fs.rmSync(bad);
    await expect(extracts.start({ ...base, id: broken.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a failed or cancelled extract says so and adds nothing', async () => {
    const extract = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'FAILED', message: 'It broke.', stderrTail: '' })
      .mockResolvedValueOnce({
        ok: false,
        code: 'CANCELLED',
        message: 'Cancelled.',
        stderrTail: '',
      });
    const { history, extracts, emit, runner } = make(extract);
    const { id } = await addFcap(history);
    const request = { id, sourceIndex: 0, startMs: 0, endMs: 2000, format: 'mp4' as const };
    await extracts.start(request);
    await runner.idle();
    await extracts.start(request);
    await runner.idle();
    expect(
      emit.failed.mock.calls.map(([event]) => [event.code, event.cancelled, event.kind]),
    ).toEqual([
      ['FAILED', false, 'extract'],
      ['CANCELLED', true, 'extract'],
    ]);
    expect(emit.done).not.toHaveBeenCalled();
    expect((await history.list()).total).toBe(1);
  });

  it('only one job at a time', async () => {
    let release: () => void = () => undefined;
    const extract = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, code: 'FAILED', message: 'x', stderrTail: '' });
        }),
    );
    const { history, extracts, runner } = make(extract);
    const { id } = await addFcap(history);
    const request = { id, sourceIndex: 0, startMs: 0, endMs: 2000, format: 'mp4' as const };
    await extracts.start(request);
    await expect(extracts.start(request)).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await runner.idle();
  });
});
