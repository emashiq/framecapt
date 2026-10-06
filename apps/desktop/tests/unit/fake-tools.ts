import fs from 'node:fs';
import {
  FfmpegError,
  type MediaTools,
  type ProbeResult,
  type RunOptions,
  type RunResult,
} from '../../src/main/media/ffmpeg';

export const PLAYABLE: ProbeResult = {
  hasVideo: true,
  hasAudio: true,
  video: { width: 1920, height: 1080, codec: 'vp9', pixFmt: 'yuv420p' },
  audioCodec: 'opus',
  durationSec: 5,
  formatName: 'matroska,webm',
  sizeBytes: 1000,
};

export const ENCODERS_WITH_H264 = [
  ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
  ' A....D libopus              libopus Opus (codec opus)',
  '',
].join('\n');

export interface FakeToolsOptions {
  /** Exit code of the fake remux; non-zero writes no output. */
  code?: number;
  stderr?: string;
  /** Called with the arguments before the fake remux "runs"; may await (to model a slow remux). */
  beforeRun?: (args: string[], options: RunOptions) => Promise<void> | void;
  /** What the fake ffprobe says about a file. */
  probe?: (file: string) => ProbeResult | Error;
  missing?: boolean;
  /** Text of the fake `ffmpeg -encoders`. */
  encoders?: string;
}

export type FakeTools = MediaTools & { runs: string[][]; probes: string[] };

/**
 * Stands in for ffmpeg/ffprobe: a "remux" copies the input file to the last argument (like
 * `-c copy` would produce a file of similar size); `probe` answers from the options.
 */
export function fakeTools(options: FakeToolsOptions = {}): FakeTools {
  const runs: string[][] = [];
  const probes: string[] = [];
  return {
    runs,
    probes,
    paths() {
      if (options.missing) throw new FfmpegError('FFMPEG_MISSING', 'FFmpeg was not found.');
      return { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' };
    },
    async run(args, runOptions = {}): Promise<RunResult> {
      runs.push(args);
      await options.beforeRun?.(args, runOptions);
      if (runOptions.signal?.aborted) throw new FfmpegError('FFMPEG_ABORTED', 'aborted');
      if ((options.code ?? 0) !== 0) {
        return { code: options.code ?? 1, stderrTail: options.stderr ?? 'boom' };
      }
      const input = args[args.indexOf('-i') + 1] as string;
      fs.copyFileSync(input, args.at(-1) as string);
      return { code: 0, stderrTail: '' };
    },
    async probe(file) {
      probes.push(file);
      const result = options.probe ? options.probe(file) : PLAYABLE;
      if (result instanceof Error) throw result;
      return result;
    },
    version: () => Promise.resolve('ffmpeg version fake'),
    encoders: () => Promise.resolve(options.encoders ?? ENCODERS_WITH_H264),
  };
}
