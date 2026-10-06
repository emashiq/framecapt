import path from 'node:path';
import {
  DEFAULT_FPS,
  GIF_DEFAULT_FPS,
  GIF_MAX_FPS,
  outputDurationMs,
  outputGeometry,
  projectSegments,
  type Item,
  type VideoProject,
} from '../../shared/video-edit';
import { localInput, mediaPath } from './ffmpeg';

/**
 * Turns a video project into one ffmpeg command: a filter graph (written to a script file the
 * caller passes with `-/filter_complex`, so the command line stays short on Windows) plus the
 * encoder arguments.
 *
 * Order: fps (MediaRecorder files are variable frame rate) -> items, in the project's order, on the
 * SOURCE timeline (`t` in `enable` is source time, because nothing has been cut yet) -> crop -> one
 * trim per kept segment, concatenated (audio and video built from the same segment list) -> fades
 * -> scale -> format. A GIF gets its palette from the final picture and no audio.
 *
 * Nothing user-written ever enters the graph: it is made of numbers (printed by `px`/`sec`/`ratio`,
 * which accept nothing else), a colour that matches `#rrggbb`, and fixed words.
 */

export interface EditArgsOptions {
  /** Where the caller wrote `filterScript` (an absolute path). */
  filterScriptPath: string;
}

export interface EditCommand {
  args: string[];
  filterScript: string;
}

/** An integer pixel value. */
function px(value: number): string {
  if (!Number.isInteger(value) || value < 0) throw new Error('Expected a whole pixel value.');
  return String(value);
}

/** Seconds with millisecond precision, never in exponent form. */
function sec(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('Expected a time.');
  return (ms / 1000).toFixed(3);
}

function ratio(value: number, digits = 2): string {
  if (!Number.isFinite(value)) throw new Error('Expected a number.');
  return value.toFixed(digits);
}

function hex(color: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Expected a colour.');
  return color.slice(1).toUpperCase();
}

/** Rounds a box outward to even coordinates (4:2:0 chroma), inside the source. */
function evenBox(item: Item, source: VideoProject['source']): Item['rect'] {
  const x = item.rect.x - (item.rect.x % 2);
  const y = item.rect.y - (item.rect.y % 2);
  const right = Math.min(source.width, item.rect.x + item.rect.width);
  const bottom = Math.min(source.height, item.rect.y + item.rect.height);
  return {
    x,
    y,
    width: Math.max(2, right - x - ((right - x) % 2)),
    height: Math.max(2, bottom - y - ((bottom - y) % 2)),
  };
}

function between(item: Item): string {
  return `enable='between(t,${sec(item.startMs)},${sec(item.endMs)})'`;
}

function frameRate(project: VideoProject): number {
  const fps = Math.round(project.source.fps ?? DEFAULT_FPS);
  return Math.max(1, Math.min(60, fps));
}

/** The graph lines of one item: they take `from` and produce `to`. */
function itemLines(
  item: Item,
  index: number,
  from: string,
  to: string,
  project: VideoProject,
): string[] {
  const { source } = project;
  switch (item.kind) {
    case 'redact': {
      const { x, y, width, height } = item.rect;
      return [
        `[${from}]drawbox=x=${px(x)}:y=${px(y)}:w=${px(width)}:h=${px(height)}:color=0x${hex(item.color)}@1:t=fill:${between(item)}[${to}]`,
      ];
    }
    case 'highlight': {
      // Spotlight: four dark bands around the box leave the box itself untouched.
      const { x, y, width, height } = item.rect;
      const dim = `black@${ratio(item.dim)}`;
      const band = (bx: number, by: number, bw: number, bh: number): string | null =>
        bw > 0 && bh > 0
          ? `drawbox=x=${px(bx)}:y=${px(by)}:w=${px(bw)}:h=${px(bh)}:color=${dim}:t=fill:${between(item)}`
          : null;
      const bands = [
        band(0, 0, source.width, y),
        band(0, y + height, source.width, source.height - (y + height)),
        band(0, y, x, height),
        band(x + width, y, source.width - (x + width), height),
      ].filter((chain): chain is string => chain !== null);
      return [`[${from}]${bands.length > 0 ? bands.join(',') : 'null'}[${to}]`];
    }
    case 'blur':
    case 'pixelate': {
      const box = evenBox(item, source);
      const region = `crop=${px(box.width)}:${px(box.height)}:${px(box.x)}:${px(box.y)}`;
      const effect =
        item.kind === 'blur'
          ? `gblur=sigma=${ratio(item.amount * 0.6)}:steps=2`
          : `pixelize=w=${px(Math.min(item.block, box.width, box.height))}:h=${px(Math.min(item.block, box.width, box.height))}`;
      const keep = `i${index}a`;
      const copy = `i${index}b`;
      const fx = `i${index}c`;
      return [
        `[${from}]split[${keep}][${copy}]`,
        `[${copy}]${region},${effect}[${fx}]`,
        `[${keep}][${fx}]overlay=${px(box.x)}:${px(box.y)}:${between(item)}[${to}]`,
      ];
    }
  }
}

/** The whole filter graph. Exported for tests; `buildEditArgs` is the entry point. */
export function buildFilterScript(project: VideoProject): string {
  const lines: string[] = [];
  const gif = project.export.format === 'gif';
  const segments = projectSegments(project);
  if (segments.length === 0) throw new Error('Nothing is left to export.');
  const total = outputDurationMs(segments);
  const geometry = outputGeometry(project);

  // 1. Constant frame rate, one pixel format, then the items on the source timeline.
  let current = 'v0';
  lines.push(`[0:v]fps=${frameRate(project)},format=yuv420p[${current}]`);
  project.items.forEach((item, index) => {
    const next = `v${index + 1}`;
    lines.push(...itemLines(item, index, current, next, project));
    current = next;
  });

  // 2. Crop.
  const { cropped } = geometry;
  const isCropped =
    project.crop !== null ||
    cropped.width !== project.source.width ||
    cropped.height !== project.source.height;
  if (isCropped) {
    lines.push(
      `[${current}]crop=${px(cropped.width)}:${px(cropped.height)}:${px(cropped.x)}:${px(cropped.y)}[vc]`,
    );
    current = 'vc';
  }

  // 3. One trim per kept segment, video and audio from the same list, then concat.
  const count = segments.length;
  const withAudio = !gif && project.source.hasAudio && !project.audio.muted;
  const names = (prefix: string): string[] => segments.map((_, i) => `${prefix}${i}`);
  const split = (input: string, filter: string, outputs: string[]): void => {
    if (outputs.length === 1)
      lines.push(`[${input}]${filter === 'split' ? 'null' : 'anull'}[${outputs[0]}]`);
    else
      lines.push(
        `[${input}]${filter}=${outputs.length}${outputs.map((name) => `[${name}]`).join('')}`,
      );
  };
  const videoIn = names('vs');
  split(current, 'split', videoIn);
  segments.forEach((segment, i) => {
    lines.push(
      `[vs${i}]trim=start=${sec(segment.startMs)}:end=${sec(segment.endMs)},setpts=PTS-STARTPTS[vt${i}]`,
    );
  });
  if (withAudio) {
    split('0:a', 'asplit', names('as'));
    segments.forEach((segment, i) => {
      lines.push(
        `[as${i}]atrim=start=${sec(segment.startMs)}:end=${sec(segment.endMs)},asetpts=PTS-STARTPTS[at${i}]`,
      );
    });
    const inputs = segments.map((_, i) => `[vt${i}][at${i}]`).join('');
    lines.push(`${inputs}concat=n=${count}:v=1:a=1[vcat][acat]`);
  } else {
    const inputs = segments.map((_, i) => `[vt${i}]`).join('');
    lines.push(`${inputs}concat=n=${count}:v=1:a=0[vcat]`);
  }

  // 4. Fades, frame rate (GIF), scale, pixel format.
  const video: string[] = [];
  if (project.fadeInMs > 0) video.push(`fade=t=in:st=0:d=${sec(project.fadeInMs)}`);
  if (project.fadeOutMs > 0) {
    video.push(`fade=t=out:st=${sec(total - project.fadeOutMs)}:d=${sec(project.fadeOutMs)}`);
  }
  if (gif) {
    video.push(`fps=${Math.min(GIF_MAX_FPS, project.export.gifFps ?? GIF_DEFAULT_FPS)}`);
  }
  if (geometry.width !== cropped.width || geometry.height !== cropped.height) {
    video.push(`scale=${px(geometry.width)}:${px(geometry.height)}:flags=lanczos`);
  }
  if (gif) {
    lines.push(`[vcat]${[...video, 'split[g0][g1]'].join(',')}`);
    lines.push('[g0]palettegen=stats_mode=diff[pal]');
    lines.push('[g1][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[vout]');
    return lines.join(';\n');
  }
  video.push('format=yuv420p');
  lines.push(`[vcat]${video.join(',')}[vout]`);

  // 5. Audio: the cut audio with volume and fades, or silence of the output's length.
  if (withAudio) {
    const audio: string[] = [];
    if (project.audio.volume !== 1) audio.push(`volume=${ratio(project.audio.volume)}`);
    if (project.fadeInMs > 0) audio.push(`afade=t=in:st=0:d=${sec(project.fadeInMs)}`);
    if (project.fadeOutMs > 0) {
      audio.push(`afade=t=out:st=${sec(total - project.fadeOutMs)}:d=${sec(project.fadeOutMs)}`);
    }
    audio.push('aformat=sample_rates=48000:channel_layouts=stereo');
    lines.push(`[acat]${audio.join(',')}[aout]`);
  } else {
    lines.push(`anullsrc=r=48000:cl=stereo:d=${sec(total)}[aout]`);
  }
  return lines.join(';\n');
}

const ENCODERS: Record<'mp4' | 'webm', string[]> = {
  mp4: [
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
  ],
  webm: [
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '32',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-cpu-used',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-f',
    'webm',
  ],
};

/**
 * The ffmpeg arguments (an array for `spawn` with `shell: false`) and the filter script they read.
 * The input is opened with the safe `localInput` (file protocol only); the paths are absolute.
 */
export function buildEditArgs(
  project: VideoProject,
  inputPath: string,
  outputPath: string,
  options: EditArgsOptions,
): EditCommand {
  const filterScript = buildFilterScript(project);
  const format = project.export.format;
  const input = localInput(
    inputPath,
    path.extname(inputPath).toLowerCase() === '.webm' ? 'matroska' : undefined,
  );
  const args = [
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:1',
    '-y',
    ...input,
    '-/filter_complex',
    mediaPath(options.filterScriptPath),
    '-map',
    '[vout]',
    ...(format === 'gif'
      ? ['-an', '-loop', '0', '-f', 'gif']
      : ['-map', '[aout]', ...ENCODERS[format]]),
    mediaPath(outputPath),
  ];
  return { args, filterScript };
}
