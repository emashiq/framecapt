import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinalizeService, finalizePlan } from '../../src/main/history/finalize-service';
import type { ConvertRequest, EncoderCapability } from '../../src/main/media/convert';
import { JobRunner, type FileJobResult } from '../../src/main/media/job-runner';
import type { ProbeResult } from '../../src/main/media/ffmpeg';
import type { Compression, SaveFormat } from '../../src/shared/recording-format';
import { fakeTools } from './fake-tools';

const ID = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const PROBE: ProbeResult = {
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-finalize-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Options {
  saveFormat?: SaveFormat;
  compression?: Compression;
  itemFormat?: 'webm' | 'mp4' | 'mkv' | 'fcap' | 'gif';
  durationMs?: number;
  ok?: boolean;
  encoders?: Partial<EncoderCapability>;
  trashFails?: boolean;
  itemGone?: boolean;
  /** The item left history while the job ran: replaceVideoFile finds nothing. */
  leftHistory?: boolean;
  hang?: boolean;
}

function setup(options: Options = {}) {
  const itemFormat = options.itemFormat ?? 'webm';
  const input = path.join(dir, `Clip.${itemFormat}`);
  fs.writeFileSync(input, 'original');
  const calls: string[] = [];
  const events: string[] = [];
  const toasts: string[] = [];
  const replaced: { from: string; to: string }[] = [];
  const added: Record<string, unknown>[] = [];
  let item = {
    id: ID,
    type: 'recording',
    createdAt: 1,
    path: input,
    width: 1920,
    height: 1080,
    durationMs: options.durationMs ?? 5000,
    sizeBytes: 8,
    format: itemFormat,
    thumbnail: 'thumb.png',
    hasAudio: true,
    source: 'screen',
    derivedFrom: null,
  } as Record<string, unknown>;
  const runner = new JobRunner();
  const service = new FinalizeService({
    history: {
      get: (id) => (id === ID && !options.itemGone ? (item as never) : undefined),
      replaceVideoFile: (_id, update) => {
        calls.push(`replace:${path.basename(update.path)}:${update.format}`);
        item = { ...item, ...update };
        return Promise.resolve(!options.leftHistory);
      },
      addVideo: (video) => {
        calls.push(`add:${path.basename(video.path)}:${video.format}:${video.derivedFrom}`);
        added.push(video as unknown as Record<string, unknown>);
        return Promise.resolve({ id: NEW_ID });
      },
    },
    tools: fakeTools(),
    encoders: () => Promise.resolve({ h264: true, vp9: true, gif: true, ...options.encoders }),
    settings: () => ({
      saveFormat: options.saveFormat ?? 'mp4',
      compression: options.compression ?? 'balanced',
    }),
    destination: (source, extension, suffix) =>
      Promise.resolve(
        path.join(
          dir,
          `${path.basename(source.path, path.extname(source.path))}${suffix}${extension}`,
        ),
      ),
    trashItem: (file) => {
      calls.push(`trash:${path.basename(file)}`);
      if (options.trashFails) return Promise.reject(new Error('no bin'));
      fs.rmSync(file, { force: true });
      return Promise.resolve();
    },
    runner,
    toast: (event) => toasts.push(event.message),
    onReplaced: (change) => replaced.push(change),
    emit: {
      progress: (event) => events.push(`progress:${event.percent}:${event.kind}`),
      done: (event) => events.push(`done:${event.itemId}:${event.kind}`),
      failed: (event) => events.push(`failed:${event.code}:${event.cancelled}:${event.kind}`),
    },
    convert: (request: ConvertRequest): Promise<FileJobResult> => {
      calls.push(
        `convert:${request.spec.format}/${request.spec.compression}${request.spec.maxWidth ? `/${request.spec.maxWidth}` : ''}:${request.sourceFormat}`,
      );
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
        });
      }
      fs.writeFileSync(request.destPath, 'converted');
      return Promise.resolve({
        ok: true,
        path: request.destPath,
        bytes: 2,
        durationMs: 5100,
        probe: PROBE,
      });
    },
  });
  return {
    service,
    runner,
    calls,
    events,
    toasts,
    replaced,
    added,
    input,
    get item() {
      return item;
    },
  };
}

describe('finalizePlan', () => {
  const recording = { type: 'recording', format: 'webm', durationMs: 5000 } as const;

  it('WebM with no compression needs nothing; everything else is a job', () => {
    expect(finalizePlan({ saveFormat: 'webm', compression: 'off' }, recording)).toBeNull();
    for (const [saveFormat, compression] of [
      ['webm', 'light'],
      ['mp4', 'off'],
      ['mkv', 'off'],
      ['gif', 'off'],
    ] as const) {
      expect(finalizePlan({ saveFormat, compression }, recording)).toEqual({
        spec: { format: saveFormat, compression },
      });
    }
  });

  it('only WebM recordings are converted: not an .fcap, an MP4 or a screenshot', () => {
    for (const item of [
      { type: 'recording', format: 'fcap', durationMs: 5000 },
      { type: 'recording', format: 'mp4', durationMs: 5000 },
      { type: 'screenshot', format: 'png', durationMs: null },
    ] as const) {
      expect(finalizePlan({ saveFormat: 'mp4', compression: 'balanced' }, item)).toBeNull();
    }
  });

  it('a GIF of more than 60 s is skipped (the WebM stays)', () => {
    expect(
      finalizePlan({ saveFormat: 'gif', compression: 'off' }, { ...recording, durationMs: 61_000 }),
    ).toEqual({ skip: 'gif-too-long' });
    expect(
      finalizePlan({ saveFormat: 'gif', compression: 'off' }, { ...recording, durationMs: 60_000 }),
    ).toHaveProperty('spec');
  });
});

describe('FinalizeService after a recording is saved', () => {
  it('updates the history item in place after the conversion, then trashes the WebM', async () => {
    const ctx = setup();
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual([
      'convert:mp4/balanced:webm',
      'replace:Clip.mp4:mp4',
      'trash:Clip.webm',
    ]);
    expect(ctx.item).toMatchObject({
      id: ID,
      format: 'mp4',
      path: path.join(dir, 'Clip.mp4'),
      sizeBytes: 2,
      thumbnail: 'thumb.png',
      createdAt: 1,
    });
    expect(fs.existsSync(ctx.input)).toBe(false);
    expect(ctx.events).toEqual(['progress:50:compress', `done:${ID}:compress`]);
    expect(ctx.replaced).toEqual([{ from: ctx.input, to: path.join(dir, 'Clip.mp4') }]);
  });

  it('the history item is replaced before the original is trashed, never the other way round', async () => {
    const ctx = setup({ saveFormat: 'mkv', compression: 'off' });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual(['convert:mkv/off:webm', 'replace:Clip.mkv:mkv', 'trash:Clip.webm']);
  });

  it('a smaller WebM (same extension) takes the original name once the original is in the Recycle Bin', async () => {
    const ctx = setup({ saveFormat: 'webm', compression: 'balanced' });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual([
      'convert:webm/balanced:webm',
      'replace:Clip (compressed).webm:webm',
      'trash:Clip.webm',
      'replace:Clip.webm:webm',
    ]);
    expect(fs.readFileSync(ctx.input, 'utf8')).toBe('converted');
    expect(fs.existsSync(path.join(dir, 'Clip (compressed).webm'))).toBe(false);
    expect(ctx.item).toMatchObject({ path: ctx.input, format: 'webm' });
    expect(ctx.replaced).toEqual([{ from: ctx.input, to: ctx.input }]);
  });

  it('a failed conversion keeps the item and the WebM untouched', async () => {
    const ctx = setup({ ok: false });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual(['convert:mp4/balanced:webm']);
    expect(ctx.item.format).toBe('webm');
    expect(fs.readFileSync(ctx.input, 'utf8')).toBe('original');
    expect(ctx.events).toContain('failed:VERIFY_FAILED:false:compress');
    expect(ctx.replaced).toEqual([]);
  });

  it('a Recycle Bin failure still finishes: the item points at the new file, the WebM stays', async () => {
    const ctx = setup({ trashFails: true });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.item.format).toBe('mp4');
    expect(fs.existsSync(ctx.input)).toBe(true);
    expect(ctx.events.at(-1)).toBe(`done:${ID}:compress`);
  });

  it('an item removed from history meanwhile keeps both files and does not touch the clipboard', async () => {
    const ctx = setup({ leftHistory: true });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual(['convert:mp4/balanced:webm', 'replace:Clip.mp4:mp4']);
    expect(fs.existsSync(ctx.input)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'Clip.mp4'))).toBe(true);
    expect(ctx.events.at(-1)).toBe('done:null:compress');
    expect(ctx.replaced).toEqual([]);
  });

  it('does nothing for a WebM with no compression, an .fcap, an MP4, missing encoders or a vanished file', async () => {
    for (const options of [
      { saveFormat: 'webm', compression: 'off' } as const,
      { itemFormat: 'fcap' } as const,
      { itemFormat: 'mp4' } as const,
    ]) {
      const ctx = setup(options);
      await ctx.service.startAfterSave(ID);
      await ctx.runner.idle();
      expect(ctx.calls).toEqual([]);
      expect(ctx.events).toEqual([]);
      expect(ctx.toasts).toEqual([]);
    }
    const noH264 = setup({ encoders: { h264: false } });
    await noH264.service.startAfterSave(ID);
    await noH264.runner.idle();
    expect(noH264.calls).toEqual([]);
    expect(noH264.toasts[0]).toMatch(/stays a WebM/);
    const gone = setup();
    fs.rmSync(gone.input);
    await gone.service.startAfterSave(ID);
    await gone.runner.idle();
    expect(gone.calls).toEqual([]);
  });

  it('a plain MKV re-wrap needs no encoder', async () => {
    const ctx = setup({
      saveFormat: 'mkv',
      compression: 'off',
      encoders: { h264: false, vp9: false, gif: false },
    });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls[0]).toBe('convert:mkv/off:webm');
  });

  it('a GIF of a recording longer than 60 s is not converted: the WebM stays and the user is told', async () => {
    const ctx = setup({ saveFormat: 'gif', compression: 'off', durationMs: 61_000 });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls).toEqual([]);
    expect(ctx.events).toEqual([]);
    expect(ctx.toasts).toHaveLength(1);
    expect(ctx.toasts[0]).toMatch(/60 s/);
    expect(ctx.item.format).toBe('webm');
  });

  it('a short recording does become a GIF', async () => {
    const ctx = setup({ saveFormat: 'gif', compression: 'off', durationMs: 20_000 });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.idle();
    expect(ctx.calls[0]).toBe('convert:gif/off:webm');
    expect(ctx.item.format).toBe('gif');
  });

  it('cancelling (also on quit) reports a cancel and keeps the WebM', async () => {
    const ctx = setup({ hang: true });
    await ctx.service.startAfterSave(ID);
    await ctx.runner.cancelAll();
    expect(ctx.calls).toEqual(['convert:mp4/balanced:webm']);
    expect(ctx.item.format).toBe('webm');
    expect(fs.existsSync(ctx.input)).toBe(true);
    expect(ctx.events).toEqual(['failed:CANCELLED:true:compress']);
  });
});

describe('FinalizeService.saveAs', () => {
  const request = (change: Record<string, unknown> = {}) =>
    ({ id: ID, format: 'mp4', compression: 'balanced', ...change }) as never;

  it('makes a new item next to the source and never replaces or trashes it', async () => {
    const ctx = setup({ saveFormat: 'webm', compression: 'off' });
    const { jobId } = await ctx.service.saveAs(request({ maxWidth: 1280 }));
    expect(jobId).toBeTruthy();
    await ctx.runner.idle();
    expect(ctx.calls).toEqual(['convert:mp4/balanced/1280:webm', `add:Clip.mp4:mp4:${ID}`]);
    expect(ctx.item).toMatchObject({ format: 'webm', path: ctx.input });
    expect(fs.readFileSync(ctx.input, 'utf8')).toBe('original');
    expect(ctx.events).toEqual(['progress:50:convert', `done:${NEW_ID}:convert`]);
    expect(ctx.replaced).toEqual([]);
  });

  it('a conversion to the same format gets its own name', async () => {
    const ctx = setup({ saveFormat: 'webm', compression: 'off' });
    await ctx.service.saveAs(request({ format: 'webm', compression: 'strong' }));
    await ctx.runner.idle();
    expect(ctx.calls[1]).toBe(`add:Clip (compressed).webm:webm:${ID}`);
    expect(ctx.added[0]).toMatchObject({ source: 'screen' });
  });

  it('an MP4 or MKV recording can be converted too (read as the right container)', async () => {
    const mp4 = setup({ itemFormat: 'mp4' });
    await mp4.service.saveAs(request({ format: 'mkv', compression: 'off' }));
    await mp4.runner.idle();
    expect(mp4.calls[0]).toBe('convert:mkv/off:mp4');
    const mkv = setup({ itemFormat: 'mkv' });
    await mkv.service.saveAs(request({ format: 'gif', compression: 'off' }));
    await mkv.runner.idle();
    expect(mkv.calls[0]).toBe('convert:gif/off:mkv');
  });

  it('a failed conversion adds nothing', async () => {
    const ctx = setup({ ok: false });
    await ctx.service.saveAs(request());
    await ctx.runner.idle();
    expect(ctx.calls).toEqual(['convert:mp4/balanced:webm']);
    expect(ctx.events).toContain('failed:VERIFY_FAILED:false:convert');
  });

  it('is refused for an .fcap or a GIF source, a no-op, a long GIF, missing encoders, a missing item or file', async () => {
    await expect(setup({ itemFormat: 'fcap' }).service.saveAs(request())).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(setup({ itemFormat: 'gif' }).service.saveAs(request())).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(
      setup().service.saveAs(request({ format: 'webm', compression: 'off' })),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(
      setup({ durationMs: 61_000 }).service.saveAs(request({ format: 'gif', compression: 'off' })),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(
      setup({ encoders: { vp9: false } }).service.saveAs(
        request({ format: 'webm', compression: 'light' }),
      ),
    ).rejects.toMatchObject({ code: 'FFMPEG_MISSING' });
    await expect(setup({ itemGone: true }).service.saveAs(request())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const missing = setup();
    fs.rmSync(missing.input);
    await expect(missing.service.saveAs(request())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
