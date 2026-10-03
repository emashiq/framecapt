import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Directory of the bundled build below `vendor/ffmpeg` (dev) or `resources/ffmpeg` (packaged). */
export const FFMPEG_PLATFORM_DIR = 'win32-x64';
export const STDERR_TAIL_BYTES = 64 * 1024;

export type FfmpegErrorCode =
  'FFMPEG_MISSING' | 'FFMPEG_FAILED' | 'FFMPEG_TIMEOUT' | 'FFMPEG_ABORTED' | 'PROBE_FAILED';

/** A typed failure of the media tools; `stderrTail` is diagnostics only, never shown to users. */
export class FfmpegError extends Error {
  constructor(
    readonly code: FfmpegErrorCode,
    message: string,
    readonly stderrTail: string = '',
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface FfmpegLocation {
  isPackaged: boolean;
  /** `process.resourcesPath` of a packaged app. */
  resourcesPath: string;
  /** The repository root in development (`app.getAppPath()`). */
  appPath: string;
}

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * The absolute paths of the bundled ffmpeg and ffprobe. Never PATH, never anything a renderer
 * said. Packaged: `<resources>/ffmpeg/win32-x64` (Forge `extraResource` copies the `vendor/ffmpeg`
 * folder by name); development: `<repo>/vendor/ffmpeg/win32-x64`.
 */
export function resolveFfmpeg(
  location: FfmpegLocation,
  exists: (file: string) => boolean = fs.existsSync,
): FfmpegPaths {
  const dir = location.isPackaged
    ? path.join(location.resourcesPath, 'ffmpeg', FFMPEG_PLATFORM_DIR)
    : path.join(location.appPath, 'vendor', 'ffmpeg', FFMPEG_PLATFORM_DIR);
  const paths = { ffmpeg: path.join(dir, 'ffmpeg.exe'), ffprobe: path.join(dir, 'ffprobe.exe') };
  if (!exists(paths.ffmpeg) || !exists(paths.ffprobe)) {
    throw new FfmpegError(
      'FFMPEG_MISSING',
      'FFmpeg was not found. Run "npm run fetch:ffmpeg" (development) or reinstall FrameCapt.',
    );
  }
  return paths;
}

/** Everything a test needs to replace: the process spawner and the tree killer. */
export interface ProcessDeps {
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  killTree: (pid: number) => void;
}

/** `taskkill /T /F` ends the process and anything it started (Windows has no process groups). */
function defaultKillTree(pid: number): void {
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => undefined);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

const DEFAULT_DEPS: ProcessDeps = {
  spawn: (file, args, options) => nodeSpawn(file, args, options),
  killTree: defaultKillTree,
};

export interface FfmpegProgress {
  /** Position in the output, microseconds (`out_time_us`/`out_time_ms`). */
  outTimeUs: number;
  done: boolean;
}

/**
 * Parses the `key=value` lines of `-progress pipe:1`. A block ends with `progress=continue` or
 * `progress=end`. (FFmpeg's `out_time_ms` is, despite its name, in microseconds.)
 */
export class ProgressParser {
  private buffer = '';
  private outTimeUs = 0;

  push(text: string): FfmpegProgress[] {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const blocks: FfmpegProgress[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) this.outTimeUs = parsed;
      } else if (key === 'progress') {
        blocks.push({ outTimeUs: this.outTimeUs, done: value === 'end' });
      }
    }
    return blocks;
  }
}

/** Keeps only the last `max` bytes of what it is given (ffmpeg can be very chatty). */
export class TailBuffer {
  private text = '';
  constructor(private readonly max: number = STDERR_TAIL_BYTES) {}

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max) this.text = this.text.slice(this.text.length - this.max);
  }

  toString(): string {
    return this.text;
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: FfmpegProgress) => void;
}

export interface RunResult {
  code: number;
  stderrTail: string;
}

/**
 * Runs one binary to completion: `shell: false`, an argument array, hidden window, no stdin.
 * Output is consumed as it arrives (stdout = progress, stderr = a 64 KB tail). Abort and timeout
 * kill the whole process tree and reject with a typed error.
 */
export function runProcess(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
  deps: ProcessDeps = DEFAULT_DEPS,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new FfmpegError('FFMPEG_ABORTED', 'The media tool was cancelled.'));
      return;
    }
    const child = deps.spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = new TailBuffer();
    const progress = new ProgressParser();
    let finished = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const kill = (): void => {
      if (child.pid !== undefined) deps.killTree(child.pid);
      else child.kill();
    };
    const onAbort = (): void => {
      kill();
      finish(() =>
        reject(
          new FfmpegError('FFMPEG_ABORTED', 'The media tool was cancelled.', stderr.toString()),
        ),
      );
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        kill();
        finish(() =>
          reject(
            new FfmpegError('FFMPEG_TIMEOUT', 'The media tool took too long.', stderr.toString()),
          ),
        );
      }, options.timeoutMs);
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      if (!options.onProgress) return;
      for (const block of progress.push(text)) options.onProgress(block);
    });
    child.stderr?.on('data', (text: string) => stderr.push(text));
    child.on('error', (error) =>
      finish(() => reject(new FfmpegError('FFMPEG_FAILED', error.message, stderr.toString()))),
    );
    child.on('close', (code) =>
      finish(() => resolve({ code: code ?? -1, stderrTail: stderr.toString() })),
    );
  });
}

// --- arguments --------------------------------------------------------------------------------

/**
 * Every file handed to ffmpeg or ffprobe is an absolute path made by main, so it can never start
 * with `-` (which the tools would read as an option). Anything else is a bug, not an input.
 */
export function mediaPath(file: string): string {
  if (!path.isAbsolute(file)) {
    throw new FfmpegError('FFMPEG_FAILED', 'Media tools only take absolute file paths.');
  }
  return file;
}

/**
 * Input options for a local file: only the `file` protocol may be opened (a crafted playlist or
 * `concat` script cannot make ffmpeg reach the network or other protocols), and, where the format
 * is known, only that demuxer is tried. Placed right before `-i`.
 */
export function localInput(file: string, format?: 'matroska'): string[] {
  return ['-protocol_whitelist', 'file', ...(format ? ['-f', format] : []), '-i', mediaPath(file)];
}

/**
 * Makes every packet's timestamps strictly increase (a packet that would not move up by at least one
 * timebase tick, 1 ms in WebM, is put one tick after its predecessor). MediaRecorder stamps frames
 * with the time they were captured at millisecond resolution; the very first frames of a recording
 * can arrive less than a millisecond apart and then carry the same timestamp (observed in about one
 * in ten recordings: "0, 0, 32, 65 ..."). Every other tool expects strictly increasing timestamps,
 * ffmpeg's muxers refuse the file ("non monotonically increasing dts"). The payload is untouched; the
 * comma is escaped because the option value is a chain of bitstream filters.
 */
export const STRICTLY_INCREASING_TIMESTAMPS =
  'setts=dts=if(gt(DTS\\,PREV_OUTDTS)\\,DTS\\,PREV_OUTDTS+1):pts=if(gt(PTS\\,PREV_OUTPTS)\\,PTS\\,PREV_OUTPTS+1)';

/**
 * MediaRecorder WebM -> WebM with Duration and Cues, streams copied (only timestamps that do not
 * increase are nudged by one tick, see STRICTLY_INCREASING_TIMESTAMPS).
 */
export function remuxArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:1',
    '-y',
    ...localInput(input, 'matroska'),
    '-c',
    'copy',
    '-map',
    '0',
    '-bsf',
    STRICTLY_INCREASING_TIMESTAMPS,
    '-f',
    'webm',
    mediaPath(output),
  ];
}

export function probeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    mediaPath(file),
  ];
}

/** One frame of a video, `seek` seconds in, at most `maxWidth` wide, as a PNG (history thumbnails). */
export function thumbnailArgs(
  input: string,
  output: string,
  seek: number,
  maxWidth: number,
): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-ss',
    seek.toFixed(3),
    ...localInput(input),
    '-frames:v',
    '1',
    '-vf',
    `scale=min(${maxWidth}\\,iw):-2`,
    mediaPath(output),
  ];
}

// --- probing ----------------------------------------------------------------------------------

const StreamSchema = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  duration: z.string().optional(),
});
const ProbeSchema = z.object({
  streams: z.array(StreamSchema).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      size: z.string().optional(),
    })
    .default({}),
});

export interface ProbeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  video: { width: number; height: number; codec: string; pixFmt: string } | null;
  /** Codec name of the first audio stream (`opus`, `aac`), null without audio. */
  audioCodec: string | null;
  /** Container duration in seconds; null when the container has none (a live MediaRecorder file). */
  durationSec: number | null;
  formatName: string;
  sizeBytes: number | null;
}

function positiveNumber(text: string | undefined): number | null {
  const value = Number(text);
  return text !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/** Validates ffprobe's JSON and reduces it to the facts the app uses. */
export function parseProbe(json: unknown): ProbeResult {
  const parsed = ProbeSchema.safeParse(json);
  if (!parsed.success) throw new FfmpegError('PROBE_FAILED', 'ffprobe returned unexpected output.');
  const { streams, format } = parsed.data;
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    video: video
      ? {
          width: video.width ?? 0,
          height: video.height ?? 0,
          codec: video.codec_name ?? '',
          pixFmt: video.pix_fmt ?? '',
        }
      : null,
    audioCodec: audio ? (audio.codec_name ?? '') : null,
    durationSec: positiveNumber(format.duration),
    formatName: format.format_name ?? '',
    sizeBytes: positiveNumber(format.size),
  };
}

/** The media tools of one install: a single object so tests can swap the whole thing. */
export interface MediaTools {
  /** Throws FFMPEG_MISSING when the binaries are not there. */
  paths(): FfmpegPaths;
  run(args: string[], options?: RunOptions): Promise<RunResult>;
  probe(file: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ProbeResult>;
  /** The first line of `ffmpeg -version`. */
  version(): Promise<string>;
  /** The raw text of `ffmpeg -hide_banner -encoders` (which encoders this build contains). */
  encoders(): Promise<string>;
}

export function createMediaTools(
  locate: () => FfmpegPaths,
  deps: ProcessDeps = DEFAULT_DEPS,
): MediaTools {
  return {
    paths: locate,
    async run(args, options) {
      return runProcess(locate().ffmpeg, args, options, deps);
    },
    async probe(file, options = {}) {
      const result = await collect(locate().ffprobe, probeArgs(file), options, deps);
      if (result.code !== 0) {
        throw new FfmpegError(
          'PROBE_FAILED',
          'ffprobe could not read the file.',
          result.stderrTail,
        );
      }
      try {
        return parseProbe(JSON.parse(result.stdout));
      } catch (error) {
        if (error instanceof FfmpegError) throw error;
        throw new FfmpegError('PROBE_FAILED', 'ffprobe returned unreadable output.');
      }
    },
    async version() {
      const result = await collect(
        locate().ffmpeg,
        ['-hide_banner', '-version'],
        { timeoutMs: 15_000 },
        deps,
      );
      const line = result.stdout.split(/\r?\n/)[0] ?? '';
      if (result.code !== 0 || !line.startsWith('ffmpeg version')) {
        throw new FfmpegError(
          'FFMPEG_FAILED',
          'ffmpeg did not report its version.',
          result.stderrTail,
        );
      }
      return line;
    },
    async encoders() {
      const result = await collect(
        locate().ffmpeg,
        ['-hide_banner', '-encoders'],
        { timeoutMs: 15_000 },
        deps,
      );
      if (result.code !== 0) {
        throw new FfmpegError(
          'FFMPEG_FAILED',
          'ffmpeg could not list its encoders.',
          result.stderrTail,
        );
      }
      return result.stdout;
    },
  };
}

/** Like runProcess but also returns stdout (small outputs only: ffprobe JSON, a version line). */
function collect(
  file: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number },
  deps: ProcessDeps,
): Promise<RunResult & { stdout: string }> {
  let stdout = '';
  const wrapped: ProcessDeps = {
    ...deps,
    spawn: (spawnFile, spawnArgs, spawnOptions) => {
      const child = deps.spawn(spawnFile, spawnArgs, spawnOptions);
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString();
      });
      return child;
    },
  };
  return runProcess(file, args, options, wrapped).then((result) => ({ ...result, stdout }));
}
