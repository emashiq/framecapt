import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompressService, postSaveAction } from '../../src/main/history/compress-service';
import { mp4Args, MP4_UNAVAILABLE_MESSAGE } from '../../src/main/media/export';
import { JobRunner } from '../../src/main/media/job-runner';
import type { ProbeResult } from '../../src/main/media/ffmpeg';
import { fakeTools } from './fake-tools';

const ID = '22222222-2222-4222-8222-222222222222';
const MP4_PROBE: ProbeResult = {
  hasVideo: true,
  hasAudio: true,
  video: { width: 1280, height: 720, codec: 'h264', pixFmt: 'yuv420p' },
  audioCodec: 'aac',
  durationSec: 5,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  sizeBytes: 100,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-compress-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: {
    storage?: 'original' | 'compressed';
    format?: 'webm' | 'mp4';
    ok?: boolean;
    capability?: boolean;
    trashFails?: boolean;
    itemGone?: boolean;
    hang?: boolean;
  } = {},
) {
  const input = path.join(dir, 'Clip.webm');
  fs.writeFileSync(input, 'webm');
  const calls: string[] = [];
  const events: string[] = [];
  let item = {
    id: ID,
    type: 'recording',
    createdAt: 1,
    path: input,
    width: 1920,
    height: 1080,
    durationMs: 5000,
    sizeBytes: 4,
    format: options.format ?? 'webm',
    thumbnail: 'thumb.png',
    hasAudio: true,
    source: 'screen',
    derivedFrom: null,
  } as const;
  const runner = new JobRunner();
  const service = new CompressService({
    history: {
      get: (id) => (id === ID && !options.itemGone ? item : undefined),
      replaceVideoFile: (id, update) => {
        calls.push(`replace:${update.path}`);
        item = { ...item, ...update, format: 'mp4' } as unknown as typeof item;
        return Promise.resolve(!options.itemGone);
      },
    },
    tools: fakeTools(),
    capability: () =>
      Promise.resolve(
        options.capability === false
          ? { available: false, reason: MP4_UNAVAILABLE_MESSAGE }
          : { available: true },
      ),
    storage: () => options.storage ?? 'compressed',
    destination: () => Promise.resolve(path.join(dir, 'Clip.mp4')),
    trashItem: (file) => {
      calls.push(`trash:${file}`);
      return options.trashFails ? Promise.reject(new Error('no bin')) : Promise.resolve();
    },
    runner,
    emit: {
      progress: (event) => events.push(`progress:${event.percent}:${event.kind}`),
      done: (event) => events.push(`done:${event.itemId}:${event.kind}`),
      failed: (event) => events.push(`failed:${event.code}:${event.cancelled}:${event.kind}`),
    },
    exportMp4: (request) => {
      calls.push(`encode:${request.profile}`);
      if (options.hang) {
        return new Promise((resolve) =>
          request.signal?.addEventListener('abort', () =>
            resolve({ ok: false, code: 'CANCELLED', message: 'cancelled', stderrTail: '' }),
          ),
        );
      }
      request.onProgress?.(50);
      if (options.ok === false) {
        return Promise.resolve({
          ok: false,
          code: 'VERIFY_FAILED',
          message: 'bad',
          stderrTail: '',
        } as const);
      }
      return Promise.resolve({
        ok: true,
        path: request.destPath,
        bytes: 2,
        durationMs: 5100,
        probe: MP4_PROBE,
      } as const);
    },
  });
  return {
    service,
    runner,
    calls,
    events,
    input,
    get item() {
      return item;
    },
  };
}

describe('CompressService', () => {
  it('updates the history item in place after the encode, then trashes the WebM', async () => {
    const ctx = setup();
    await ctx.service.startIfEnabled(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual([
      'encode:compressed',
      `replace:${path.join(dir, 'Clip.mp4')}`,
      `trash:${ctx.input}`,
    ]);
    expect(ctx.item).toMatchObject({
      id: ID,
      format: 'mp4',
      sizeBytes: 2,
      thumbnail: 'thumb.png',
      createdAt: 1,
    });
    expect(ctx.events).toEqual(['progress:50:compress', `done:${ID}:compress`]);
  });

  it('a failed compression keeps the item and the WebM untouched', async () => {
    const ctx = setup({ ok: false });
    await ctx.service.startIfEnabled(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual(['encode:compressed']);
    expect(ctx.item.format).toBe('webm');
    expect(ctx.events).toContain('failed:VERIFY_FAILED:false:compress');
  });

  it('a Recycle Bin failure still finishes: the item points at the MP4', async () => {
    const ctx = setup({ trashFails: true });
    await ctx.service.startIfEnabled(ID);
    await ctx.runner.idle();
    expect(ctx.item.format).toBe('mp4');
    expect(ctx.events.at(-1)).toBe(`done:${ID}:compress`);
  });

  it('does nothing for original storage, non-WebM items, missing H.264 or a vanished file', async () => {
    for (const options of [
      { storage: 'original' as const },
      { format: 'mp4' as const },
      { capability: false },
    ]) {
      const ctx = setup(options);
      await ctx.service.startIfEnabled(ID);
      await ctx.runner.idle();
      expect(ctx.calls).toEqual([]);
      expect(ctx.events).toEqual([]);
    }
    const gone = setup();
    fs.rmSync(gone.input);
    await gone.service.startIfEnabled(ID);
    await gone.runner.idle();
    expect(gone.calls).toEqual([]);
  });

  it('cancelling (also on quit) reports a cancel and keeps the WebM', async () => {
    const ctx = setup({ hang: true });
    await ctx.service.startIfEnabled(ID);
    await ctx.runner.cancelAll();
    expect(ctx.calls).toEqual(['encode:compressed']);
    expect(ctx.item.format).toBe('webm');
    expect(ctx.events).toEqual(['failed:CANCELLED:true:compress']);
  });

  it('compressed storage wins over the automatic MP4 export (one job)', () => {
    expect(postSaveAction({ storage: 'compressed', autoExportMp4: true })).toBe('compress');
    expect(postSaveAction({ storage: 'compressed', autoExportMp4: false })).toBe('compress');
    expect(postSaveAction({ storage: 'original', autoExportMp4: true })).toBe('export');
    expect(postSaveAction({ storage: 'original', autoExportMp4: false })).toBeNull();
  });

  it('uses the compressed quality profile in the ffmpeg arguments', () => {
    const args = mp4Args('/in.webm', '/out.mp4', 'compressed');
    expect(args.slice(args.indexOf('-preset'), args.indexOf('-preset') + 4)).toEqual([
      '-preset',
      'medium',
      '-crf',
      '28',
    ]);
    expect(args[args.indexOf('-b:a') + 1]).toBe('96k');
    expect(args).toContain('+faststart');
    expect(args).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  });
});
