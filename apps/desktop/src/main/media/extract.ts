import path from 'node:path';
import type { ExtractFormat } from '../../shared/history-ipc';
import type { Rect } from '../../shared/rect';
import { floorEven } from '../../shared/recording';
import { DURATION_TOLERANCE_SEC } from './export';
import { mediaInputArgs, mediaPath, type ProbeResult } from './ffmpeg';
import { runFileJob, type FileJobResult } from './job-runner';
import type { MediaTools } from './ffmpeg';

/** Even sides (4:2:0): the width and height a crop produces. */
export function evenCropSize(crop: Rect | null, picture: { width: number; height: number }) {
  return crop
    ? { width: floorEven(crop.width), height: floorEven(crop.height) }
    : { width: floorEven(picture.width), height: floorEven(picture.height) };
}

export interface ExtractSpec {
  /** The `.fcap` (its path and format `fcap`). */
  input: { path: string; format: string };
  startMs: number;
  endMs: number;
  /** One source's tile in the picture, or null for the whole picture. */
  crop: Rect | null;
  format: ExtractFormat;
}

const VIDEO_CODEC: Record<ExtractFormat, string[]> = {
  mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
  webm: [
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '30',
    '-b:v',
    '0',
    '-deadline',
    'good',
    '-cpu-used',
    '5',
    '-row-mt',
    '1',
    '-pix_fmt',
    'yuv420p',
  ],
};
const AUDIO_CODEC: Record<ExtractFormat, string[]> = {
  mp4: ['-c:a', 'aac', '-b:a', '160k'],
  webm: ['-c:a', 'libopus', '-b:a', '128k'],
};

/**
 * ffmpeg arguments that cut `[startMs, endMs)` out of a `.fcap` and crop one source's tile (even
 * sides). `-ss` before the input seeks the payload (a re-encode, so the cut is exact); the length
 * is `-t`. An array for `spawn` with `shell: false`: the only variable parts are the two paths.
 */
export function extractArgs(spec: ExtractSpec, output: string): string[] {
  const { crop } = spec;
  const filters = [
    ...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []),
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  ];
  return [
    '-hide_banner',
    '-y',
    '-ss',
    (spec.startMs / 1000).toFixed(3),
    ...mediaInputArgs(spec.input),
    '-t',
    ((spec.endMs - spec.startMs) / 1000).toFixed(3),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    filters.join(','),
    ...VIDEO_CODEC[spec.format],
    ...AUDIO_CODEC[spec.format],
    ...(spec.format === 'mp4' ? ['-movflags', '+faststart'] : []),
    '-progress',
    'pipe:1',
    '-nostats',
    mediaPath(output),
  ];
}

/** What is wrong with a finished extract, or null: the right container, codec, size and length. */
export function verifyExtract(
  output: ProbeResult,
  source: ProbeResult,
  expected: { format: ExtractFormat; width: number; height: number; durationSec: number },
): string | null {
  const names = output.formatName.split(',');
  if (!names.includes(expected.format === 'mp4' ? 'mp4' : 'webm')) {
    return `The output is not a ${expected.format.toUpperCase()} file.`;
  }
  const codec = expected.format === 'mp4' ? 'h264' : 'vp9';
  if (!output.hasVideo || output.video?.codec !== codec) return 'The output has no video.';
  if (output.video.width !== expected.width || output.video.height !== expected.height) {
    return 'The output has an unexpected size.';
  }
  if (source.hasAudio && !output.hasAudio) return 'The output lost the audio track.';
  if (output.durationSec === null) return 'The output has no duration.';
  if (Math.abs(output.durationSec - expected.durationSec) > DURATION_TOLERANCE_SEC + 0.1) {
    return 'The output has a different length than requested.';
  }
  return null;
}

export interface ExtractRequest {
  tools: MediaTools;
  spec: ExtractSpec;
  /** The `.fcap`'s picture size, to know the output size of a whole-picture extract. */
  picture: { width: number; height: number };
  destPath: string;
  signal?: AbortSignal;
  onProgress?: (percent: number | null) => void;
}

/** Extracts through a partial file and a rename (see `runFileJob`); the `.fcap` is only read. */
export function extractFromFcap(request: ExtractRequest): Promise<FileJobResult> {
  const { spec, destPath } = request;
  const wanted = spec.format === 'mp4' ? '.mp4' : '.webm';
  if (path.extname(destPath).toLowerCase() !== wanted) {
    return Promise.resolve({
      ok: false,
      code: 'INVALID_DESTINATION',
      message: `The extract needs a ${wanted} file name.`,
      stderrTail: '',
    });
  }
  const size = evenCropSize(spec.crop, request.picture);
  const durationSec = (spec.endMs - spec.startMs) / 1000;
  return runFileJob({
    tools: request.tools,
    sourcePath: spec.input.path,
    destPath,
    ...(request.signal && { signal: request.signal }),
    ...(request.onProgress && { onProgress: request.onProgress }),
    args: (partial) => extractArgs(spec, partial),
    verify: (output, source) =>
      verifyExtract(output, source, { format: spec.format, ...size, durationSec }),
    noun: 'extract',
    sourceFormat: spec.input.format,
    outputDurationSec: durationSec,
  });
}
