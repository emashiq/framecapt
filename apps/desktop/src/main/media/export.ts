import fs from 'node:fs';
import path from 'node:path';
import { FfmpegError, localInput, mediaPath, type MediaTools, type ProbeResult } from './ffmpeg';
import { runFileJob, type FileJobFailureCode, type FileJobResult } from './job-runner';

export { partialPathFor, percentOf } from './job-runner';

/** Shown wherever MP4 export is offered but this FFmpeg build cannot make it. */
export const MP4_UNAVAILABLE_MESSAGE =
  'MP4 export needs an FFmpeg build with H.264 — your recording is saved as WebM';

/** The output may differ from the source's duration by this much (container rounding, VFR to CFR). */
export const DURATION_TOLERANCE_SEC = 0.5;

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

/** "export" is the user's "Export MP4"; "compressed" is the smaller storage copy (settings). */
export type Mp4Profile = 'export' | 'compressed';
const MP4_PROFILES: Record<Mp4Profile, { preset: string; crf: string; audioBitrate: string }> = {
  export: { preset: 'veryfast', crf: '20', audioBitrate: '160k' },
  compressed: { preset: 'medium', crf: '28', audioBitrate: '96k' },
};

/**
 * WebM (VP8/VP9 + Opus) -> MP4 (H.264 + AAC). Sides are rounded down to even numbers (4:2:0
 * needs it), `+faststart` moves the index to the front so the file plays while it loads. An array
 * for `spawn` with `shell: false`; the only variable parts are the two paths.
 */
export function mp4Args(input: string, output: string, profile: Mp4Profile = 'export'): string[] {
  const quality = MP4_PROFILES[profile];
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
    quality.preset,
    '-crf',
    quality.crf,
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:a',
    'aac',
    '-b:a',
    quality.audioBitrate,
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

export type Mp4FailureCode = FileJobFailureCode;
export type Mp4Result = FileJobResult;

export interface Mp4Request {
  tools: MediaTools;
  sourcePath: string;
  destPath: string;
  signal?: AbortSignal;
  /** 0..99 while encoding, null when the length of the source is not known. */
  onProgress?: (percent: number | null) => void;
  /** "export" (default) or the smaller "compressed" storage profile. */
  profile?: Mp4Profile;
}

/** Case-insensitive path equality (Windows file names). */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Converts a recording to MP4 through a partial file: probe the source, encode, probe the result
 * (H.264, AAC when the source had audio, same duration within 0.5 s), then rename onto
 * `destPath`. On cancel, timeout, failure or a failed check the partial file is deleted. The
 * source is only ever read.
 */
export async function exportMp4(request: Mp4Request): Promise<Mp4Result> {
  const { sourcePath, destPath } = request;
  if (path.extname(destPath).toLowerCase() !== '.mp4' || samePath(sourcePath, destPath)) {
    return {
      ok: false,
      code: 'INVALID_DESTINATION',
      message: 'Choose a different .mp4 file name.',
      stderrTail: '',
    };
  }
  const profile = request.profile ?? 'export';
  return runFileJob({
    tools: request.tools,
    sourcePath,
    destPath,
    ...(request.signal && { signal: request.signal }),
    ...(request.onProgress && { onProgress: request.onProgress }),
    args: (partial) => mp4Args(sourcePath, partial, profile),
    verify: verifyMp4,
    noun: profile === 'compressed' ? 'compression' : 'export',
  });
}
