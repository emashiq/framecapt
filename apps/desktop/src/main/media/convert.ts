import path from 'node:path';
import {
  GIF_FPS,
  GIF_MAX_WIDTH,
  type Compression,
  type SaveFormat,
} from '../../shared/recording-format';
import { DURATION_TOLERANCE_SEC, parseEncoders } from './export';
import { localInput, mediaPath, type MediaTools, type ProbeResult } from './ffmpeg';
import { runFileJob, type FileJobResult } from './job-runner';

/** What a finished recording is turned into: a container, how hard it is re-encoded, how wide it may be. */
export interface ConvertSpec {
  format: SaveFormat;
  compression: Compression;
  /** Longest side of the picture in pixels; the picture is only ever made smaller. */
  maxWidth?: number | undefined;
}

/** True when the job only re-wraps the streams (no re-encode, no quality change). */
export function isRemux(spec: ConvertSpec): boolean {
  return spec.format === 'mkv' && spec.compression === 'off' && spec.maxWidth === undefined;
}

type Level = Exclude<Compression, 'off'>;

/** libx264 (MP4 and MKV): `crf` and the AAC rate. Preset `medium` for every level. */
const X264: Record<Level, { crf: string; audio: string }> = {
  light: { crf: '23', audio: '128k' },
  balanced: { crf: '28', audio: '96k' },
  strong: { crf: '32', audio: '64k' },
};
/** MP4 without compression: a high-quality H.264 copy (MP4 needs H.264, so it is a re-encode). */
const X264_OFF = { preset: 'veryfast', crf: '20', audio: '160k' };
/** libvpx-vp9 constant quality (`-b:v 0`) and the Opus rate. */
const VP9: Record<Level, { crf: string; audio: string }> = {
  light: { crf: '33', audio: '96k' },
  balanced: { crf: '38', audio: '64k' },
  strong: { crf: '43', audio: '48k' },
};

/** Even sides (4:2:0 needs them); with a width cap the height follows the aspect ratio. */
function scaleFilter(maxWidth: number | undefined): string {
  return maxWidth === undefined
    ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    : `scale=trunc(min(${maxWidth}\\,iw)/2)*2:-2`;
}

function videoArgs(spec: ConvertSpec): string[] {
  const { format, compression } = spec;
  const filter = scaleFilter(spec.maxWidth);
  if (format === 'gif') {
    const width = Math.min(spec.maxWidth ?? GIF_MAX_WIDTH, GIF_MAX_WIDTH);
    // A palette per clip, bayer dithering keeps the file small; no audio (GIF has none).
    return [
      '-an',
      '-vf',
      `fps=${GIF_FPS},scale=min(${width}\\,iw):-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer`,
      '-loop',
      '0',
    ];
  }
  if (format === 'webm') {
    const quality = VP9[compression === 'off' ? 'light' : compression];
    return [
      '-vf',
      filter,
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      quality.crf,
      '-row-mt',
      '1',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-b:a',
      quality.audio,
    ];
  }
  const profile =
    compression === 'off'
      ? X264_OFF
      : { preset: 'medium', crf: X264[compression].crf, audio: X264[compression].audio };
  return [
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    profile.preset,
    '-crf',
    profile.crf,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    profile.audio,
    ...(format === 'mp4' ? ['-movflags', '+faststart'] : []),
  ];
}

const MUXER: Record<SaveFormat, string> = { webm: 'webm', mp4: 'mp4', mkv: 'matroska', gif: 'gif' };
export const EXTENSION: Record<SaveFormat, string> = {
  webm: '.webm',
  mp4: '.mp4',
  mkv: '.mkv',
  gif: '.gif',
};

/**
 * The ffmpeg arguments (an array for `spawn` with `shell: false`) that turn `input` into `output`
 * in the spec's format. `inputFormat` 'matroska' for a WebM or MKV source (only that demuxer is
 * tried); the only variable parts are the two absolute paths and the numbers of the spec.
 */
export function convertArgs(
  spec: ConvertSpec,
  input: string,
  output: string,
  inputFormat?: 'matroska',
): string[] {
  const body = isRemux(spec)
    ? ['-map', '0', '-c', 'copy']
    : ['-map', '0:v:0', ...(spec.format === 'gif' ? [] : ['-map', '0:a:0?']), ...videoArgs(spec)];
  return [
    '-hide_banner',
    '-y',
    ...localInput(input, inputFormat),
    ...body,
    '-f',
    MUXER[spec.format],
    '-progress',
    'pipe:1',
    '-nostats',
    mediaPath(output),
  ];
}

/** A GIF's length is a frame count at 12 fps: allow a little more than a container's rounding. */
function tolerance(format: SaveFormat, sourceSec: number): number {
  return format === 'gif' ? Math.max(0.6, sourceSec * 0.05) : DURATION_TOLERANCE_SEC;
}

const EXPECTED_VIDEO: Partial<Record<SaveFormat, string>> = {
  mp4: 'h264',
  webm: 'vp9',
  gif: 'gif',
};
const EXPECTED_AUDIO: Partial<Record<SaveFormat, string>> = { mp4: 'aac', webm: 'opus' };

/** What is wrong with a finished conversion, or null: the container, codec, audio and length. */
export function verifyConvert(
  spec: ConvertSpec,
  output: ProbeResult,
  source: ProbeResult,
): string | null {
  const label = spec.format.toUpperCase();
  if (!output.formatName.split(',').includes(MUXER[spec.format])) {
    return `The output is not a ${label} file.`;
  }
  const video = isRemux(spec) ? undefined : EXPECTED_VIDEO[spec.format];
  if (!output.hasVideo || (video !== undefined && output.video?.codec !== video)) {
    return `The output has no ${spec.format === 'gif' ? 'GIF' : 'video'} picture.`;
  }
  if (spec.format !== 'gif' && source.hasAudio) {
    const audio = isRemux(spec) ? source.audioCodec : EXPECTED_AUDIO[spec.format];
    if (!output.hasAudio || (audio !== undefined && output.audioCodec !== audio)) {
      return 'The output lost the audio track.';
    }
  }
  if (output.durationSec === null) return 'The output has no duration.';
  if (
    source.durationSec !== null &&
    Math.abs(output.durationSec - source.durationSec) > tolerance(spec.format, source.durationSec)
  ) {
    return 'The output has a different length than the recording.';
  }
  return null;
}

export interface ConvertRequest {
  tools: MediaTools;
  /** A WebM, MP4 or MKV recording (never a `.fcap`). */
  sourcePath: string;
  /** The history format of the source: WebM and MKV are read as Matroska. */
  sourceFormat: 'webm' | 'mp4' | 'mkv';
  destPath: string;
  spec: ConvertSpec;
  signal?: AbortSignal;
  onProgress?: (percent: number | null) => void;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Converts a recording through a partial file (see `runFileJob`): encode, probe and verify the
 * result, rename onto `destPath`. Cancel, timeout, failure or a failed check delete the partial
 * file; the source is only ever read.
 */
export function convertVideo(request: ConvertRequest): Promise<FileJobResult> {
  const { sourcePath, destPath, spec } = request;
  if (
    path.extname(destPath).toLowerCase() !== EXTENSION[spec.format] ||
    samePath(sourcePath, destPath)
  ) {
    return Promise.resolve({
      ok: false,
      code: 'INVALID_DESTINATION',
      message: `Choose a different ${EXTENSION[spec.format]} file name.`,
      stderrTail: '',
    });
  }
  const matroska = request.sourceFormat === 'mp4' ? undefined : ('matroska' as const);
  return runFileJob({
    tools: request.tools,
    sourcePath,
    destPath,
    ...(request.signal && { signal: request.signal }),
    ...(request.onProgress && { onProgress: request.onProgress }),
    args: (partial) => convertArgs(spec, sourcePath, partial, matroska),
    verify: (output, source) => verifyConvert(spec, output, source),
    noun: spec.compression === 'off' && spec.format !== 'gif' ? 'conversion' : 'compression',
  });
}

// --- capability -------------------------------------------------------------------------------

/** Which encoders this ffmpeg build has (asked once at startup). A missing build offers nothing. */
export interface EncoderCapability {
  /** libx264 and aac: MP4, and MKV or WebM sources re-encoded to H.264. */
  h264: boolean;
  /** libvpx-vp9 and libopus: WebM output. */
  vp9: boolean;
  gif: boolean;
}

export async function detectEncoders(tools: MediaTools): Promise<EncoderCapability> {
  try {
    const encoders = parseEncoders(await tools.encoders());
    return {
      h264: encoders.has('libx264') && encoders.has('aac'),
      vp9: encoders.has('libvpx-vp9') && encoders.has('libopus'),
      gif: encoders.has('gif'),
    };
  } catch {
    return { h264: false, vp9: false, gif: false };
  }
}

/** Whether the spec can be produced with these encoders (a remux needs none). */
export function canConvert(spec: ConvertSpec, encoders: EncoderCapability): boolean {
  if (isRemux(spec)) return true;
  if (spec.format === 'gif') return encoders.gif;
  if (spec.format === 'webm') return encoders.vp9;
  return encoders.h264;
}
