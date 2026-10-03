import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FfmpegError,
  localInput,
  mediaPath,
  type FfmpegProgress,
  type MediaTools,
  type ProbeResult,
} from './ffmpeg';

/** Shown wherever MP4 export is offered but this FFmpeg build cannot make it. */
export const MP4_UNAVAILABLE_MESSAGE =
  'MP4 export needs an FFmpeg build with H.264 — your recording is saved as WebM';

/** The output may differ from the source's duration by this much (container rounding, VFR to CFR). */
export const DURATION_TOLERANCE_SEC = 0.5;
const PROBE_TIMEOUT_MS = 30_000;
const MIN_EXPORT_TIMEOUT_MS = 10 * 60_000;
/** Free space the destination volume must keep beyond the source's size while exporting. */
const FREE_MARGIN_BYTES = 100 * 1024 * 1024;

// --- capability -------------------------------------------------------------------------------

export interface Mp4Capability {
  available: boolean;
  /** Why MP4 export is not offered (user-facing), when it is not. */
  reason?: string;
}

/** The encoder names of `ffmpeg -encoders` output (`V....D libx264   H.264 ...` lines). */
export function parseEncoders(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[VAS][.FSXBD]{5}\s+(\S+)/.exec(line);
    if (match?.[1] && match[1] !== '=') names.add(match[1]);
  }
  return names;
}

/**
 * MP4 is only offered with `libx264` (H.264) and the native `aac` encoder in the bundled build.
 * Asked once at startup and cached by the caller; a missing or unusable ffmpeg is "unavailable",
 * never an exception.
 */
export async function detectMp4Capability(tools: MediaTools): Promise<Mp4Capability> {
  try {
    const encoders = parseEncoders(await tools.encoders());
    if (encoders.has('libx264') && encoders.has('aac')) return { available: true };
  } catch (error) {
    if (error instanceof FfmpegError && error.code === 'FFMPEG_MISSING') {
      return { available: false, reason: error.message };
    }
  }
  return { available: false, reason: MP4_UNAVAILABLE_MESSAGE };
}

// --- arguments and verification ---------------------------------------------------------------

/**
 * WebM (VP8/VP9 + Opus) -> MP4 (H.264 + AAC). Sides are rounded down to even numbers (4:2:0
 * needs it), `+faststart` moves the index to the front so the file plays while it loads. An array
 * for `spawn` with `shell: false`; the only variable parts are the two paths.
 */
export function mp4Args(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-y',
    ...localInput(input, 'matroska'),
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
    mediaPath(output),
  ];
}

/** What is wrong with a finished MP4, or null when it is H.264 (+ AAC) with the source's length. */
export function verifyMp4(output: ProbeResult, source: ProbeResult): string | null {
  if (!output.formatName.split(',').includes('mp4')) return 'The output is not an MP4 file.';
  if (!output.hasVideo || output.video?.codec !== 'h264') return 'The output has no H.264 video.';
  if (source.hasAudio && output.audioCodec !== 'aac') return 'The output lost the audio track.';
  if (output.durationSec === null) return 'The output has no duration.';
  if (
    source.durationSec !== null &&
    Math.abs(output.durationSec - source.durationSec) > DURATION_TOLERANCE_SEC
  ) {
    return 'The output has a different length than the recording.';
  }
  return null;
}

/** Progress 0..99 from ffmpeg's output position; null when the source has no known duration. */
export function percentOf(progress: FfmpegProgress, durationSec: number | null): number | null {
  if (durationSec === null || durationSec <= 0) return null;
  return Math.max(0, Math.min(99, Math.floor((progress.outTimeUs / 1e6 / durationSec) * 100)));
}

/**
 * Top-level box types of an MP4 file in file order (`ftyp`, `moov`, `mdat`, ...). Reads only the
 * box headers. `moov` before `mdat` means the file is "fast start".
 */
export async function mp4TopLevelBoxes(file: string, limit = 32): Promise<string[]> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const types: string[] = [];
    let offset = 0;
    const header = Buffer.alloc(16);
    while (offset + 8 <= size && types.length < limit) {
      await handle.read(header, 0, 16, offset);
      let length = header.readUInt32BE(0);
      types.push(header.toString('latin1', 4, 8));
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      else if (length === 0) length = size - offset;
      if (length < 8) break;
      offset += length;
    }
    return types;
  } finally {
    await handle.close();
  }
}

// --- the export -------------------------------------------------------------------------------

export type Mp4FailureCode =
  | 'INVALID_DESTINATION'
  | 'SOURCE_UNREADABLE'
  | 'LOW_DISK'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'FAILED'
  | 'VERIFY_FAILED';

export type Mp4Result =
  | { ok: true; path: string; bytes: number; durationMs: number; probe: ProbeResult }
  | { ok: false; code: Mp4FailureCode; message: string; stderrTail: string };

export interface Mp4Request {
  tools: MediaTools;
  sourcePath: string;
  destPath: string;
  signal?: AbortSignal;
  /** 0..99 while encoding, null when the length of the source is not known. */
  onProgress?: (percent: number | null) => void;
}

function failure(code: Mp4FailureCode, message: string, stderrTail = ''): Mp4Result {
  return { ok: false, code, message, stderrTail };
}

/** The temporary output: next to the destination (one volume, so the rename is atomic) and unique. */
export function partialPathFor(destPath: string): string {
  const token = randomBytes(6).toString('hex');
  return path.join(path.dirname(destPath), `.framecapt-export-${token}.partial.mp4`);
}

/** Case-insensitive path equality (Windows file names). */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Converts a recording to MP4 through a partial file: probe the source, encode, probe the result
 * (H.264, AAC when the source had audio, same duration within 0.5 s), then rename onto
 * `destPath`. On cancel, timeout, failure or a failed check the partial file (the one this call
 * made, nothing else) is deleted. The source is only ever read.
 */
export async function exportMp4(request: Mp4Request): Promise<Mp4Result> {
  const { tools, sourcePath, destPath, signal } = request;
  if (path.extname(destPath).toLowerCase() !== '.mp4' || samePath(sourcePath, destPath)) {
    return failure('INVALID_DESTINATION', 'Choose a different .mp4 file name.');
  }
  if (signal?.aborted) return failure('CANCELLED', 'The export was cancelled.');

  let sourceProbe: ProbeResult;
  let sourceBytes: number;
  try {
    sourceBytes = (await fs.promises.stat(sourcePath)).size;
    sourceProbe = await tools.probe(sourcePath, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    if (error instanceof FfmpegError && error.code === 'FFMPEG_ABORTED') {
      return failure('CANCELLED', 'The export was cancelled.');
    }
    return failure('SOURCE_UNREADABLE', 'The recording could not be read.');
  }
  if (!sourceProbe.hasVideo) return failure('SOURCE_UNREADABLE', 'The file has no video.');

  const partial = partialPathFor(destPath);
  try {
    const stat = await fs.promises.statfs(path.dirname(destPath)).catch(() => null);
    if (stat && Number(stat.bavail) * Number(stat.bsize) < sourceBytes + FREE_MARGIN_BYTES) {
      return failure('LOW_DISK', 'There is not enough free space to export the video.');
    }

    const timeoutMs = Math.max(MIN_EXPORT_TIMEOUT_MS, (sourceProbe.durationSec ?? 0) * 4000);
    let last: number | null = -1;
    const run = await tools
      .run(mp4Args(sourcePath, partial), {
        timeoutMs,
        ...(signal && { signal }),
        onProgress: (progress) => {
          const percent = percentOf(progress, sourceProbe.durationSec);
          if (percent === last) return;
          last = percent;
          request.onProgress?.(percent);
        },
      })
      .catch((error: unknown) => {
        if (error instanceof FfmpegError) return error;
        throw error;
      });
    if (run instanceof FfmpegError) {
      if (run.code === 'FFMPEG_ABORTED') return failure('CANCELLED', 'The export was cancelled.');
      if (run.code === 'FFMPEG_TIMEOUT') {
        return failure('TIMEOUT', 'The export took too long and was stopped.', run.stderrTail);
      }
      return failure('FAILED', 'The video could not be converted.', run.stderrTail);
    }
    if (run.code !== 0) {
      return failure('FAILED', 'The video could not be converted.', run.stderrTail);
    }

    let outputProbe: ProbeResult;
    try {
      outputProbe = await tools.probe(partial, {
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(signal && { signal }),
      });
    } catch (error) {
      if (error instanceof FfmpegError && error.code === 'FFMPEG_ABORTED') {
        return failure('CANCELLED', 'The export was cancelled.');
      }
      return failure('VERIFY_FAILED', 'The converted video could not be checked.');
    }
    const problem = verifyMp4(outputProbe, sourceProbe);
    if (problem) return failure('VERIFY_FAILED', problem);

    await fs.promises.rename(partial, destPath);
    const bytes = (await fs.promises.stat(destPath)).size;
    request.onProgress?.(100);
    return {
      ok: true,
      path: destPath,
      bytes,
      durationMs: Math.round((outputProbe.durationSec ?? 0) * 1000),
      probe: outputProbe,
    };
  } catch (error) {
    if (error instanceof FfmpegError) return failure('FAILED', error.message, error.stderrTail);
    return failure('FAILED', 'The video could not be saved.');
  } finally {
    // Whatever is still named like this belongs to this call (success renamed it away). ffmpeg may
    // need a moment to release the file after it was killed, so retry.
    await fs.promises
      .rm(partial, { force: true, maxRetries: 20, retryDelay: 100 })
      .catch(() => undefined);
  }
}
