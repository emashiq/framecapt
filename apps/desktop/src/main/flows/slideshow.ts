import { mediaPath } from '../media/ffmpeg';

/** Seconds each step stays on screen in the MP4 and GIF slideshows. */
export const SLIDE_SECONDS = 2.5;

export type SlideshowKind = 'mp4' | 'gif';

const LIMITS: Record<SlideshowKind, { width: number; height: number }> = {
  mp4: { width: 1920, height: 1080 },
  gif: { width: 960, height: 540 },
};

/** The slideshow size: the first picture fitted into the box (never enlarged), sides made even. */
export function slideshowSize(
  kind: SlideshowKind,
  first: { width: number; height: number },
): { width: number; height: number } {
  const box = LIMITS[kind];
  const scale = Math.min(1, box.width / first.width, box.height / first.height);
  const even = (value: number): number => Math.max(2, Math.floor((value * scale) / 2) * 2);
  return { width: even(first.width), height: even(first.height) };
}

/** The numbered picture files of one export: `frame-0001.png`, `frame-0002.png` ... */
export const frameName = (index: number): string =>
  `frame-${String(index + 1).padStart(4, '0')}.png`;

/**
 * The input of the slideshow: the numbered pictures read as an image sequence at one picture per
 * `SLIDE_SECONDS`. (The concat demuxer with `duration` lines was measured and rejected: with the
 * pinned ffmpeg 9.0.2 the length of the last slide depended on how many slides there were.) The
 * pictures are scaled to fit and padded to one size, so steps from different screens mix.
 */
function sequenceInput(dir: string): string[] {
  return [
    '-protocol_whitelist',
    'file',
    '-framerate',
    String(1 / SLIDE_SECONDS),
    '-i',
    `${mediaPath(dir).replace(/\\/g, '/')}/frame-%04d.png`,
  ];
}

const fitTo = ({ width, height }: { width: number; height: number }): string =>
  `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
  `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

export interface SlideshowArgsInput {
  /** The folder holding `frame-0001.png` ... (absolute; no `%` in its path, which the sequence reader would take for a pattern). */
  dir: string;
  size: { width: number; height: number };
  /** Where the video goes (absolute). */
  output: string;
}

/** MP4: H.264 4:2:0 at a constant 30 fps, the index first. Arguments for `spawn` with `shell: false`. */
export function mp4SlideshowArgs(input: SlideshowArgsInput): string[] {
  return [
    '-hide_banner',
    '-y',
    ...sequenceInput(input.dir),
    '-vf',
    `${fitTo(input.size)},format=yuv420p`,
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-progress',
    'pipe:1',
    '-nostats',
    mediaPath(input.output),
  ];
}

/**
 * GIF: 10 frames a second, a palette per picture (`stats_mode=single`, `new=1`), looping. The
 * rate is the output option `-r 10`: with the pinned ffmpeg 9.0.2 an `fps=10` filter made the GIF
 * stop after a few slides, and one palette for the whole run (`palettegen` waiting for the end,
 * or a second pass) stalled or failed. Measured for one to eight steps, same size or mixed.
 */
export function gifSlideshowArgs(input: SlideshowArgsInput): string[] {
  return [
    '-hide_banner',
    '-y',
    ...sequenceInput(input.dir),
    '-r',
    '10',
    '-vf',
    `${fitTo(input.size)},split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1`,
    '-loop',
    '0',
    '-f',
    'gif',
    '-progress',
    'pipe:1',
    '-nostats',
    mediaPath(input.output),
  ];
}
