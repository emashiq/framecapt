import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportService } from '../../src/main/history/export-service';
import {
  detectMp4Capability,
  exportMp4,
  mp4Args,
  mp4TopLevelBoxes,
  MP4_UNAVAILABLE_MESSAGE,
  parseEncoders,
  percentOf,
  verifyMp4,
} from '../../src/main/media/export';
import { FfmpegError, ProgressParser, type ProbeResult } from '../../src/main/media/ffmpeg';
import { ENCODERS_WITH_H264, fakeTools, PLAYABLE } from './fake-tools';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-mp4-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const MP4_PROBE: ProbeResult = {
  hasVideo: true,
  hasAudio: true,
  video: { width: 1280, height: 720, codec: 'h264', pixFmt: 'yuv420p' },
  audioCodec: 'aac',
  durationSec: 5.2,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  sizeBytes: 1000,
};

/** Probe answers: the WebM source is PLAYABLE (5 s, opus), anything .mp4 is the given MP4 facts. */
function probeFor(mp4: ProbeResult = MP4_PROBE) {
  return (file: string) => (file.endsWith('.mp4') ? mp4 : PLAYABLE);
}

function partials(): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes('.partial.'));
}

describe('mp4Args', () => {
  it('is the documented H.264 + AAC command, as an array', () => {
    const args = mp4Args('C:/in.webm', 'C:/out.partial.mp4');
    expect(args).toEqual([
      '-hide_banner',
      '-y',
      '-protocol_whitelist',
      'file',
      '-f',
      'matroska',
      '-i',
      'C:/in.webm',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      'C:/out.partial.mp4',
    ]);
  });

  it('keeps awkward paths as single arguments (no shell is involved)', () => {
    const awkward = 'C:\\Users\\A B\\"quoted" & calc.exe; -rf\\clip.webm';
    const args = mp4Args(awkward, 'C:\\out dir\\x.partial.mp4');
    expect(args[args.indexOf('-i') + 1]).toBe(awkward);
    expect(args.at(-1)).toBe('C:\\out dir\\x.partial.mp4');
    expect(args.filter((arg) => arg === awkward)).toHaveLength(1);
  });
});

describe('capability detection', () => {
  it('parses encoder lines and ignores the legend', () => {
    const names = parseEncoders(
      [
        'Encoders:',
        ' V..... = Video',
        ' A..... = Audio',
        ' ------',
        ' V....D libx264              libx264 H.264',
        ' A....D aac                  AAC (Advanced Audio Coding)',
        ' A....D aac_mf               AAC via MediaFoundation',
      ].join('\n'),
    );
    expect([...names].sort()).toEqual(['aac', 'aac_mf', 'libx264']);
  });

  it('is available only with libx264 and the native aac encoder', async () => {
    expect(await detectMp4Capability(fakeTools({ encoders: ENCODERS_WITH_H264 }))).toEqual({
      available: true,
    });
    const noH264 = ' V....D libvpx-vp9  VP9\n A....D aac  AAC\n';
    expect(await detectMp4Capability(fakeTools({ encoders: noH264 }))).toEqual({
      available: false,
      reason: MP4_UNAVAILABLE_MESSAGE,
    });
    const onlyMediaFoundation = ' V....D libx264  H.264\n A....D aac_mf  AAC via MF\n';
    expect(
      (await detectMp4Capability(fakeTools({ encoders: onlyMediaFoundation }))).available,
    ).toBe(false);
  });

  it('a missing or broken ffmpeg means unavailable, never an exception', async () => {
    const missing = fakeTools();
    missing.encoders = () =>
      Promise.reject(new FfmpegError('FFMPEG_MISSING', 'FFmpeg was not found.'));
    expect(await detectMp4Capability(missing)).toEqual({
      available: false,
      reason: 'FFmpeg was not found.',
    });
    const broken = fakeTools();
    broken.encoders = () => Promise.reject(new FfmpegError('FFMPEG_FAILED', 'x'));
    expect((await detectMp4Capability(broken)).reason).toBe(MP4_UNAVAILABLE_MESSAGE);
  });
});

describe('progress and verification', () => {
  it('turns ffmpeg progress blocks into percent of the probed duration', () => {
    const parser = new ProgressParser();
    const blocks = parser.push(
      'frame=10\nout_time_us=1000000\nprogress=continue\nout_time_us=2500000\nprogress=continue\nout_time_us=5000000\nprogress=end\n',
    );
    expect(blocks.map((block) => percentOf(block, 5))).toEqual([20, 50, 99]);
    expect(percentOf(blocks[0]!, null)).toBeNull();
    expect(percentOf({ outTimeUs: -5, done: false }, 5)).toBe(0);
    expect(percentOf({ outTimeUs: 9e9, done: false }, 5)).toBe(99);
  });

  it('accepts H.264 + AAC of the same length and rejects anything else', () => {
    expect(verifyMp4(MP4_PROBE, PLAYABLE)).toBeNull();
    expect(verifyMp4({ ...MP4_PROBE, durationSec: 5.49 }, PLAYABLE)).toBeNull();
    expect(verifyMp4({ ...MP4_PROBE, durationSec: 5.6 }, PLAYABLE)).toMatch(/different length/);
    expect(verifyMp4({ ...MP4_PROBE, durationSec: null }, PLAYABLE)).toMatch(/no duration/);
    expect(verifyMp4({ ...MP4_PROBE, formatName: 'matroska,webm' }, PLAYABLE)).toMatch(
      /not an MP4/,
    );
    expect(
      verifyMp4({ ...MP4_PROBE, video: { ...MP4_PROBE.video!, codec: 'vp9' } }, PLAYABLE),
    ).toMatch(/H.264/);
    expect(verifyMp4({ ...MP4_PROBE, audioCodec: null, hasAudio: false }, PLAYABLE)).toMatch(
      /audio/,
    );
    // A silent source does not need audio in the result.
    const silent = { ...PLAYABLE, hasAudio: false, audioCodec: null };
    expect(verifyMp4({ ...MP4_PROBE, audioCodec: null, hasAudio: false }, silent)).toBeNull();
  });

  it('reads the top-level boxes of an MP4 (moov before mdat is fast start)', async () => {
    const box = (type: string, size: number) => {
      const buffer = Buffer.alloc(size);
      buffer.writeUInt32BE(size, 0);
      buffer.write(type, 4, 'latin1');
      return buffer;
    };
    const fast = path.join(dir, 'fast.mp4');
    fs.writeFileSync(fast, Buffer.concat([box('ftyp', 24), box('moov', 100), box('mdat', 500)]));
    const slow = path.join(dir, 'slow.mp4');
    fs.writeFileSync(slow, Buffer.concat([box('ftyp', 24), box('mdat', 500), box('moov', 100)]));
    expect(await mp4TopLevelBoxes(fast)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(await mp4TopLevelBoxes(slow)).toEqual(['ftyp', 'mdat', 'moov']);
  });
});

describe('exportMp4', () => {
  function source(): string {
    const file = path.join(dir, 'Clip.webm');
    fs.writeFileSync(file, 'webm-bytes'.repeat(100));
    return file;
  }

  it('encodes into a partial file, verifies it and renames it onto the destination', async () => {
    const input = source();
    const before = sha(input);
    const dest = path.join(dir, 'Clip.mp4');
    const percents: (number | null)[] = [];
    const tools = fakeTools({
      probe: probeFor(),
      beforeRun: (args, options) => {
        expect(path.basename(args.at(-1) as string)).toMatch(
          /^\.framecapt-export-[0-9a-f]+\.partial\.mp4$/,
        );
        options.onProgress?.({ outTimeUs: 1_000_000, done: false });
        options.onProgress?.({ outTimeUs: 1_000_000, done: false }); // same value: reported once
        options.onProgress?.({ outTimeUs: 2_500_000, done: false });
      },
    });
    const result = await exportMp4({
      tools,
      sourcePath: input,
      destPath: dest,
      onProgress: (percent) => percents.push(percent),
    });
    expect(result).toMatchObject({ ok: true, path: dest, durationMs: 5200 });
    expect(percents).toEqual([20, 50, 100]);
    expect(fs.existsSync(dest)).toBe(true);
    expect(partials()).toEqual([]);
    expect(sha(input)).toBe(before);
    expect(tools.runs[0]).toContain('libx264');
  });

  it('cancel kills the job, deletes only its own partial file and leaves the original alone', async () => {
    const input = source();
    const before = sha(input);
    const decoy = path.join(dir, 'Other.partial.mp4'); // not ours: must survive
    fs.writeFileSync(decoy, 'someone elses');
    const controller = new AbortController();
    const tools = fakeTools({
      probe: probeFor(),
      beforeRun: async (args, options) => {
        fs.writeFileSync(args.at(-1) as string, 'half-written');
        expect(partials()).toHaveLength(2);
        setTimeout(() => controller.abort(), 10);
        await new Promise((resolve) => options.signal?.addEventListener('abort', resolve));
      },
    });
    const result = await exportMp4({
      tools,
      sourcePath: input,
      destPath: path.join(dir, 'Clip.mp4'),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(partials()).toEqual(['Other.partial.mp4']);
    expect(fs.readFileSync(decoy, 'utf8')).toBe('someone elses');
    expect(fs.existsSync(path.join(dir, 'Clip.mp4'))).toBe(false);
    expect(sha(input)).toBe(before);
  });

  it('a retry after a cancel works', async () => {
    const input = source();
    const controller = new AbortController();
    controller.abort();
    const tools = fakeTools({ probe: probeFor() });
    expect(
      await exportMp4({
        tools,
        sourcePath: input,
        destPath: path.join(dir, 'a.mp4'),
        signal: controller.signal,
      }),
    ).toMatchObject({ code: 'CANCELLED' });
    expect(
      await exportMp4({ tools, sourcePath: input, destPath: path.join(dir, 'a.mp4') }),
    ).toMatchObject({
      ok: true,
    });
  });

  it('reports a failed encode, keeps the source and leaves no partial file', async () => {
    const input = source();
    const before = sha(input);
    const tools = fakeTools({
      probe: probeFor(),
      code: 1,
      stderr: 'Error while opening encoder',
      beforeRun: (args) => fs.writeFileSync(args.at(-1) as string, 'junk'),
    });
    const result = await exportMp4({ tools, sourcePath: input, destPath: path.join(dir, 'a.mp4') });
    expect(result).toMatchObject({
      ok: false,
      code: 'FAILED',
      stderrTail: 'Error while opening encoder',
    });
    expect(partials()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'a.mp4'))).toBe(false);
    expect(sha(input)).toBe(before);
  });

  it('does not publish a file that fails the checks', async () => {
    const input = source();
    for (const bad of [
      { ...MP4_PROBE, video: { ...MP4_PROBE.video!, codec: 'vp9' } },
      { ...MP4_PROBE, durationSec: 9 },
      { ...MP4_PROBE, audioCodec: null },
    ]) {
      const result = await exportMp4({
        tools: fakeTools({ probe: probeFor(bad) }),
        sourcePath: input,
        destPath: path.join(dir, 'a.mp4'),
      });
      expect(result).toMatchObject({ ok: false, code: 'VERIFY_FAILED' });
      expect(fs.existsSync(path.join(dir, 'a.mp4'))).toBe(false);
      expect(partials()).toEqual([]);
    }
  });

  it('a timeout is reported as such and cleans up', async () => {
    const input = source();
    const tools = fakeTools({ probe: probeFor() });
    tools.run = async (args) => {
      fs.writeFileSync(args.at(-1) as string, 'half');
      throw new FfmpegError('FFMPEG_TIMEOUT', 'took too long', 'tail');
    };
    const result = await exportMp4({ tools, sourcePath: input, destPath: path.join(dir, 'a.mp4') });
    expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(partials()).toEqual([]);
  });

  it('refuses a destination that is not an .mp4 or is the source', async () => {
    const input = source();
    const tools = fakeTools({ probe: probeFor() });
    for (const destPath of [path.join(dir, 'a.webm'), path.join(dir, 'a'), input]) {
      expect(await exportMp4({ tools, sourcePath: input, destPath })).toMatchObject({
        ok: false,
        code: 'INVALID_DESTINATION',
      });
    }
    expect(tools.runs).toEqual([]);
    expect(
      await exportMp4({
        tools,
        sourcePath: input.replace('.webm', '.MP4'),
        destPath: input.replace('.webm', '.mp4'),
      }),
    ).toMatchObject({ code: 'INVALID_DESTINATION' });
  });

  it('an unreadable or video-less source never starts ffmpeg', async () => {
    const tools = fakeTools({ probe: () => ({ ...PLAYABLE, hasVideo: false, video: null }) });
    const input = source();
    expect(
      await exportMp4({ tools, sourcePath: input, destPath: path.join(dir, 'a.mp4') }),
    ).toMatchObject({
      code: 'SOURCE_UNREADABLE',
    });
    expect(
      await exportMp4({
        tools: fakeTools(),
        sourcePath: path.join(dir, 'missing.webm'),
        destPath: path.join(dir, 'a.mp4'),
      }),
    ).toMatchObject({ code: 'SOURCE_UNREADABLE' });
    expect(tools.runs).toEqual([]);
  });
});

describe('ExportService', () => {
  const ID = '22222222-2222-4222-8222-222222222222';

  function setup(
    options: { pick?: string | null; capability?: boolean; type?: 'webm' | 'mp4' } = {},
  ) {
    const input = path.join(dir, 'Clip.webm');
    fs.writeFileSync(input, 'webm');
    const events: string[] = [];
    const added: unknown[] = [];
    const picks: { path: string }[] = [];
    const service = new ExportService({
      history: {
        get: (id) =>
          id === ID
            ? ({
                id: ID,
                type: 'recording',
                createdAt: 1,
                path: input,
                width: 1280,
                height: 720,
                durationMs: 5000,
                sizeBytes: 4,
                format: options.type ?? 'webm',
                thumbnail: null,
                hasAudio: true,
                source: 'screen',
                derivedFrom: null,
              } as const)
            : undefined,
        addVideo: (video) => {
          added.push(video);
          return Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' });
        },
      },
      tools: fakeTools(),
      capability: () =>
        Promise.resolve(
          options.capability === false
            ? { available: false, reason: MP4_UNAVAILABLE_MESSAGE }
            : { available: true },
        ),
      pickDestination: (source) => {
        picks.push(source);
        return Promise.resolve(
          options.pick === undefined ? path.join(dir, 'Clip.mp4') : options.pick,
        );
      },
      emit: {
        progress: (event) => events.push(`progress:${event.percent}`),
        done: (event) => events.push(`done:${event.itemId}`),
        failed: (event) => events.push(`failed:${event.code}:${event.cancelled}`),
      },
      exportMp4: async (request) => {
        request.onProgress?.(40);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30);
          request.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (request.signal?.aborted) {
          return { ok: false, code: 'CANCELLED', message: 'cancelled', stderrTail: '' };
        }
        return { ok: true, path: request.destPath, bytes: 9, durationMs: 5100, probe: MP4_PROBE };
      },
    });
    return { service, events, added, picks, input };
  }

  it('resolves the source from history, asks main for the destination and adds the MP4 to history', async () => {
    const { service, events, added, picks, input } = setup();
    const started = await service.start(ID);
    expect(started).toHaveProperty('jobId');
    expect(picks).toEqual([{ path: input }]);
    await service.settled();
    expect(events).toEqual(['progress:40', 'done:33333333-3333-4333-8333-333333333333']);
    expect(added).toEqual([
      expect.objectContaining({
        format: 'mp4',
        derivedFrom: ID,
        durationMs: 5100,
        width: 1280,
        hasAudio: true,
      }),
    ]);
    expect(service.active).toBe(false);
  });

  it('rejects a second export while one runs, then allows it again', async () => {
    const { service } = setup();
    await service.start(ID);
    await expect(service.start(ID)).rejects.toMatchObject({ code: 'BUSY' });
    await service.settled();
    expect(await service.start(ID)).toHaveProperty('jobId');
    await service.settled();
  });

  it('cancel stops the job and reports it as cancelled, not failed', async () => {
    const { service, events } = setup();
    const started = (await service.start(ID)) as { jobId: string };
    service.cancel(started.jobId);
    await service.settled();
    expect(events).toEqual(['progress:40', 'failed:CANCELLED:true']);
    expect(() => service.cancel(started.jobId)).toThrow(/not running/);
  });

  it('a cancelled save dialog starts nothing', async () => {
    const { service, events } = setup({ pick: null });
    expect(await service.start(ID)).toEqual({ cancelled: true });
    expect(events).toEqual([]);
    expect(service.active).toBe(false);
  });

  it('refuses unknown ids, non-WebM items and builds without H.264', async () => {
    await expect(
      setup().service.start('11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(setup({ type: 'mp4' }).service.start(ID)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    const noEncoder = setup({ capability: false });
    await expect(noEncoder.service.start(ID)).rejects.toMatchObject({
      code: 'FFMPEG_MISSING',
      message: MP4_UNAVAILABLE_MESSAGE,
    });
    expect(noEncoder.picks).toEqual([]);
  });

  it('a source that vanished is a calm error', async () => {
    const { service, input } = setup();
    fs.rmSync(input);
    await expect(service.start(ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
