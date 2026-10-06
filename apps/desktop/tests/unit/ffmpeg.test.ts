import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createMediaTools,
  FfmpegError,
  parseProbe,
  probeArgs,
  ProgressParser,
  remuxArgs,
  STRICTLY_INCREASING_TIMESTAMPS,
  resolveFfmpeg,
  runProcess,
  STDERR_TAIL_BYTES,
  TailBuffer,
  thumbnailArgs,
  type ProcessDeps,
  ffmpegPlatformDir,
} from '../../src/main/media/ffmpeg';
import { mp4Args } from '../../src/main/media/export';

describe('resolveFfmpeg', () => {
  const WIN = { platform: 'win32', arch: 'x64' } as const;
  const LINUX = { platform: 'linux', arch: 'x64' } as const;
  const location = {
    isPackaged: false,
    resourcesPath: path.join('C:', 'App', 'resources'),
    appPath: path.join('C:', 'repo'),
  };

  it('development: <repo>/vendor/ffmpeg/win32-x64, absolute file names, no PATH lookup', () => {
    const paths = resolveFfmpeg(location, () => true, WIN);
    expect(paths.ffmpeg).toBe(
      path.join('C:', 'repo', 'vendor', 'ffmpeg', 'win32-x64', 'ffmpeg.exe'),
    );
    expect(paths.ffprobe).toBe(
      path.join('C:', 'repo', 'vendor', 'ffmpeg', 'win32-x64', 'ffprobe.exe'),
    );
  });

  it('packaged: <resources>/ffmpeg/win32-x64', () => {
    const paths = resolveFfmpeg({ ...location, isPackaged: true }, () => true, WIN);
    expect(paths.ffmpeg).toBe(
      path.join('C:', 'App', 'resources', 'ffmpeg', 'win32-x64', 'ffmpeg.exe'),
    );
  });

  it('linux: <platform>-<arch> folder, extensionless names, dev and packaged', () => {
    const dev = resolveFfmpeg({ ...location, appPath: '/repo' }, () => true, LINUX);
    expect(dev.ffmpeg).toBe(path.join('/repo', 'vendor', 'ffmpeg', 'linux-x64', 'ffmpeg'));
    expect(dev.ffprobe).toBe(path.join('/repo', 'vendor', 'ffmpeg', 'linux-x64', 'ffprobe'));
    const packaged = resolveFfmpeg(
      { ...location, isPackaged: true, resourcesPath: '/opt/FrameCapt/resources' },
      () => true,
      LINUX,
    );
    expect(packaged.ffmpeg).toBe(
      path.join('/opt/FrameCapt/resources', 'ffmpeg', 'linux-x64', 'ffmpeg'),
    );
  });

  it('the folder name follows the platform and architecture', () => {
    expect(ffmpegPlatformDir('win32', 'x64')).toBe('win32-x64');
    expect(ffmpegPlatformDir('linux', 'x64')).toBe('linux-x64');
    expect(ffmpegPlatformDir()).toBe(`${process.platform}-${process.arch}`);
  });

  it('a missing binary is the typed error FFMPEG_MISSING with the fix in the message', () => {
    for (const present of [false, true]) {
      let calls = 0;
      try {
        resolveFfmpeg(location, () => present && calls++ === 0);
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FfmpegError);
        expect((error as FfmpegError).code).toBe('FFMPEG_MISSING');
        expect((error as FfmpegError).message).toContain('npm run fetch:ffmpeg');
      }
    }
  });
});

describe('argument building', () => {
  it('remux copies every stream and writes WebM, with machine-readable progress', () => {
    const args = remuxArgs('/in.webm', '/out.partial.webm');
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-progress',
      'pipe:1',
      '-y',
      // Only local files, and only the Matroska/WebM demuxer, for the recorder's own stream.
      '-protocol_whitelist',
      'file',
      '-f',
      'matroska',
      '-i',
      '/in.webm',
      '-c',
      'copy',
      '-map',
      '0',
      '-bsf',
      STRICTLY_INCREASING_TIMESTAMPS,
      '-f',
      'webm',
      '/out.partial.webm',
    ]);
    // The commas inside the expression are escaped for the filter-chain parser.
    expect(STRICTLY_INCREASING_TIMESTAMPS).toContain('\\,');
    expect(STRICTLY_INCREASING_TIMESTAMPS.replaceAll('\\,', '')).not.toContain(',');
    expect(STRICTLY_INCREASING_TIMESTAMPS.startsWith('setts=')).toBe(true);
  });

  it('relative paths and paths that look like options are refused, never passed on', () => {
    for (const bad of ['in.webm', '-i', '-f', '--help', './x.webm', 'x/../-y']) {
      expect(() => remuxArgs(bad, '/out.webm'), bad).toThrow(FfmpegError);
      expect(() => remuxArgs('/in.webm', bad), bad).toThrow(FfmpegError);
      expect(() => probeArgs(bad), bad).toThrow(FfmpegError);
    }
  });

  it('every input is opened with the file protocol only (no network via a crafted playlist)', () => {
    const inputs: string[][] = [
      remuxArgs('/a.webm', '/b.webm'),
      mp4Args('/a.webm', '/b.mp4'),
      thumbnailArgs('/a.mp4', '/t.png', 1, 480),
      probeArgs('/a.webm'),
    ];
    for (const args of inputs) {
      const at = args.indexOf('-protocol_whitelist');
      expect(at, args.join(' ')).toBeGreaterThanOrEqual(0);
      expect(args[at + 1]).toBe('file');
      // ... and it applies to the input: it comes before the file name.
      expect(at).toBeLessThan(args.findIndex((arg) => arg.startsWith('/')));
    }
  });

  it('a path with spaces or shell characters stays ONE argument (no shell is involved)', () => {
    const nasty = '/Users/a b/FrameCapt "x" & calc.webm';
    expect(remuxArgs(nasty, nasty + '.out').filter((arg) => arg.includes('calc'))).toHaveLength(2);
    expect(probeArgs(nasty).at(-1)).toBe(nasty);
  });
});

describe('ProgressParser', () => {
  it('reads out_time blocks, also when the text arrives in pieces', () => {
    const parser = new ProgressParser();
    expect(parser.push('frame=10\nout_time_us=1500')).toEqual([]);
    expect(parser.push('000\nspeed=2x\nprogress=continue\n')).toEqual([
      { outTimeUs: 1_500_000, done: false },
    ]);
    expect(parser.push('out_time_ms=4000000\r\nprogress=end\r\n')).toEqual([
      { outTimeUs: 4_000_000, done: true },
    ]);
  });

  it('ignores garbage and N/A values', () => {
    const parser = new ProgressParser();
    expect(parser.push('out_time_us=N/A\nnonsense\nprogress=continue\n')).toEqual([
      { outTimeUs: 0, done: false },
    ]);
  });
});

describe('TailBuffer', () => {
  it('keeps only the last 64 KB', () => {
    const tail = new TailBuffer();
    tail.push('a'.repeat(STDERR_TAIL_BYTES));
    tail.push('b'.repeat(10));
    expect(tail.toString()).toHaveLength(STDERR_TAIL_BYTES);
    expect(tail.toString().endsWith('b'.repeat(10))).toBe(true);
    expect(tail.toString().startsWith('a')).toBe(true);
  });
});

// --- a fake process spawner --------------------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeDeps() {
  const spawned: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const killed: number[] = [];
  const children: FakeChild[] = [];
  const deps: ProcessDeps = {
    spawn: (file, args, options) => {
      const child = new FakeChild();
      children.push(child);
      spawned.push({ file, args, options });
      return child as unknown as ChildProcess;
    },
    killTree: (pid) => killed.push(pid),
  };
  return { deps, spawned, killed, children };
}

describe('runProcess', () => {
  it('spawns with shell:false, hidden window, no stdin and the argument array as given', async () => {
    const { deps, spawned, children } = fakeDeps();
    const promise = runProcess('/ff/ffmpeg.exe', ['-i', 'a b.webm'], {}, deps);
    children[0]?.emit('close', 0);
    await expect(promise).resolves.toEqual({ code: 0, stderrTail: '' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.file).toBe('/ff/ffmpeg.exe');
    expect(spawned[0]?.args).toEqual(['-i', 'a b.webm']);
    expect(spawned[0]?.options.shell).toBe(false);
    expect(spawned[0]?.options.windowsHide).toBe(true);
    expect(spawned[0]?.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('the media tools use shell:false for ffmpeg, ffprobe and the version check alike', async () => {
    const { deps, spawned, children } = fakeDeps();
    const tools = createMediaTools(
      () => ({ ffmpeg: '/ff/ffmpeg.exe', ffprobe: '/ff/ffprobe.exe' }),
      deps,
    );
    const run = tools.run(['-version']);
    children[0]?.emit('close', 0);
    await run;
    const probe = tools.probe('/x.webm');
    children[1]?.stdout.write(JSON.stringify({ streams: [], format: {} }));
    children[1]?.emit('close', 0);
    await probe;
    const version = tools.version();
    children[2]?.stdout.write('ffmpeg version 9.0.2-test\nmore\n');
    children[2]?.emit('close', 0);
    await expect(version).resolves.toBe('ffmpeg version 9.0.2-test');
    expect(spawned.map((entry) => path.basename(entry.file))).toEqual([
      'ffmpeg.exe',
      'ffprobe.exe',
      'ffmpeg.exe',
    ]);
    expect(spawned.every((entry) => entry.options.shell === false)).toBe(true);
    expect(spawned.every((entry) => Array.isArray(entry.args))).toBe(true);
  });

  it('reports progress and keeps the stderr tail', async () => {
    const { deps, children } = fakeDeps();
    const seen: number[] = [];
    const promise = runProcess('f', [], { onProgress: (p) => seen.push(p.outTimeUs) }, deps);
    children[0]?.stdout.write('out_time_us=2000000\nprogress=continue\n');
    children[0]?.stderr.write('x'.repeat(STDERR_TAIL_BYTES + 500));
    children[0]?.stderr.write('THE-END');
    await new Promise((resolve) => setImmediate(resolve));
    children[0]?.emit('close', 3);
    const result = await promise;
    expect(seen).toEqual([2_000_000]);
    expect(result.code).toBe(3);
    expect(result.stderrTail).toHaveLength(STDERR_TAIL_BYTES);
    expect(result.stderrTail.endsWith('THE-END')).toBe(true);
  });

  it('abort kills the whole process tree and rejects FFMPEG_ABORTED', async () => {
    const { deps, killed } = fakeDeps();
    const controller = new AbortController();
    const promise = runProcess('f', [], { signal: controller.signal }, deps);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'FFMPEG_ABORTED' });
    expect(killed).toEqual([4242]);
  });

  it('an already aborted signal never spawns', async () => {
    const { deps, spawned } = fakeDeps();
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess('f', [], { signal: controller.signal }, deps)).rejects.toMatchObject({
      code: 'FFMPEG_ABORTED',
    });
    expect(spawned).toHaveLength(0);
  });

  it('a timeout kills the tree and rejects FFMPEG_TIMEOUT', async () => {
    const { deps, killed } = fakeDeps();
    await expect(runProcess('f', [], { timeoutMs: 20 }, deps)).rejects.toMatchObject({
      code: 'FFMPEG_TIMEOUT',
    });
    expect(killed).toEqual([4242]);
  });

  it('a spawn error is FFMPEG_FAILED', async () => {
    const { deps, children } = fakeDeps();
    const promise = runProcess('f', [], {}, deps);
    children[0]?.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toMatchObject({ code: 'FFMPEG_FAILED' });
  });
});

describe('parseProbe', () => {
  it('reduces ffprobe JSON to the facts the app needs', () => {
    const probe = parseProbe({
      streams: [
        { codec_type: 'video', codec_name: 'vp9', width: 1920, height: 1080, pix_fmt: 'yuv420p' },
        { codec_type: 'audio', codec_name: 'opus' },
      ],
      format: { format_name: 'matroska,webm', duration: '4.998000', size: '12345' },
    });
    expect(probe).toEqual({
      hasVideo: true,
      hasAudio: true,
      video: { width: 1920, height: 1080, codec: 'vp9', pixFmt: 'yuv420p' },
      audioCodec: 'opus',
      durationSec: 4.998,
      formatName: 'matroska,webm',
      sizeBytes: 12345,
    });
  });

  it('a container without a duration (N/A or missing) has durationSec null', () => {
    expect(parseProbe({ streams: [], format: { duration: 'N/A' } }).durationSec).toBeNull();
    expect(parseProbe({ streams: [], format: {} }).durationSec).toBeNull();
    expect(parseProbe({ streams: [], format: { duration: '0.000000' } }).durationSec).toBeNull();
  });

  it('rejects output of the wrong shape', () => {
    expect(() => parseProbe({ streams: 'nope' })).toThrow(FfmpegError);
    expect(() => parseProbe(null)).toThrow(FfmpegError);
  });
});
