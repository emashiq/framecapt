import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Verification helpers around the vendored ffmpeg/ffprobe (the same binaries the app bundles). */
const projectRoot = path.resolve(__dirname, '..', '..');
const vendorDir = path.join(projectRoot, 'vendor', 'ffmpeg', 'win32-x64');
export const FFMPEG = path.join(vendorDir, 'ffmpeg.exe');
export const FFPROBE = path.join(vendorDir, 'ffprobe.exe');

export interface Probed {
  format?: { duration?: string; size?: string };
  streams: { codec_type: string; codec_name?: string; width?: number; height?: number }[];
}

export function probeFile(file: string): Probed {
  return JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      shell: false,
      encoding: 'utf8',
    }),
  ) as Probed;
}

/** The EBML Cues element id: a seek index exists. */
export function hasCues(file: string): boolean {
  return fs.readFileSync(file).indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])) !== -1;
}

/** Decodes everything (video and audio) and a seek in the middle; both must be error free. */
export function decodesClean(file: string): { clean: boolean; seekClean: boolean } {
  const all = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    shell: false,
    encoding: 'utf8',
  });
  const seek = spawnSync(
    FFMPEG,
    ['-v', 'error', '-ss', '1', '-i', file, '-t', '1', '-f', 'null', '-'],
    { shell: false, encoding: 'utf8' },
  );
  return {
    clean: all.status === 0 && all.stderr.trim() === '',
    seekClean: seek.status === 0 && seek.stderr.trim() === '',
  };
}

/**
 * A 5 s VP9 + Opus WebM in the shape MediaRecorder produces: written as a live stream, so it has
 * no Duration and no Cues.
 */
export function generateLiveWebm(seconds = 5): Buffer {
  const run = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      String(seconds),
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-c:a',
      'libopus',
      '-f',
      'webm',
      '-live',
      '1',
      'pipe:1',
    ],
    { shell: false, maxBuffer: 256 << 20 },
  );
  if (run.status !== 0) throw new Error(`could not generate a test stream: ${run.stderr}`);
  return run.stdout;
}
