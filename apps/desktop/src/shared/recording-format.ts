/** What a saved recording becomes (Settings → Recording, History → Save as…). Shared by main and the UI. */
export const SAVE_FORMATS = ['webm', 'mp4', 'mkv', 'gif'] as const;
export type SaveFormat = (typeof SAVE_FORMATS)[number];

export const COMPRESSION_LEVELS = ['off', 'light', 'balanced', 'strong'] as const;
export type Compression = (typeof COMPRESSION_LEVELS)[number];

/** A GIF is for short clips: a longer recording keeps its WebM (and the user is told). */
export const GIF_MAX_SECONDS = 60;
export const GIF_FPS = 12;
export const GIF_MAX_WIDTH = 1280;

/** The smallest and largest "max width" a Save as… may ask for. */
export const MIN_OUTPUT_WIDTH = 160;
export const MAX_OUTPUT_WIDTH = 7680;

/**
 * The bitrate factor the live recorder uses for a compression level (the recorder cannot re-encode,
 * so "balanced" and "strong" also record at a lower bitrate; the finalize job then shrinks the file).
 */
export const REALTIME_BITRATE_FACTOR: Record<Compression, number> = {
  off: 1,
  light: 1,
  balanced: 0.6,
  strong: 0.45,
};

/** The live recorder's bitrate factor for these record options (older manifests say `compressed`). */
export function bitrateFactorOf(options: {
  compression?: Compression | undefined;
  compressed?: boolean | undefined;
}): number {
  return REALTIME_BITRATE_FACTOR[options.compression ?? (options.compressed ? 'balanced' : 'off')];
}

export const SAVE_FORMAT_LABEL: Record<SaveFormat, string> = {
  webm: 'WebM',
  mp4: 'MP4',
  mkv: 'MKV',
  gif: 'GIF',
};

export const COMPRESSION_LABEL: Record<Compression, string> = {
  off: 'Off',
  light: 'Light',
  balanced: 'Balanced',
  strong: 'Strong',
};

/** True when saving a recording in this format needs a post-processing job at all. */
export function needsFinalize(format: SaveFormat, compression: Compression): boolean {
  return !(format === 'webm' && compression === 'off');
}

/** The one-line effect of the settings, shown under the controls. */
export function formatHint(format: SaveFormat, compression: Compression): string {
  if (format === 'gif') {
    return `GIF is for short clips (up to ${GIF_MAX_SECONDS} s), has no sound and is large. A longer recording stays a WebM.`;
  }
  const kind = format === 'webm' ? 'WebM' : format === 'mp4' ? 'MP4' : 'MKV';
  switch (compression) {
    case 'off':
      if (format === 'webm') return 'Recordings stay as recorded: WebM, no extra processing.';
      if (format === 'mkv')
        return 'Recordings are re-wrapped as MKV without re-encoding: no quality change, same size.';
      return 'Recordings are converted to MP4 (H.264) at high quality; the file is usually a little larger or smaller than the WebM.';
    case 'light':
      return `Light: about 20–40 % smaller ${kind}, quality hardly changes.`;
    case 'balanced':
      return `Balanced: about 40–60 % smaller ${kind}, quality nearly unchanged.`;
    case 'strong':
      return `Strong: about 60–80 % smaller ${kind}, softer detail in busy scenes.`;
  }
}

/** A recording stored as `.fcap` (several sources in one file) stays as it is. */
export const FCAP_FORMAT_HINT =
  'Multi-source recordings (.fcap) are not converted or compressed: they stay as recorded. Extract a source to get a normal video.';

/** Converting a file to its own format with no compression and no width change would change nothing. */
export function isNoopConversion(
  source: SaveFormat,
  target: { format: SaveFormat; compression: Compression; maxWidth?: number | undefined },
): boolean {
  return target.format === source && target.compression === 'off' && target.maxWidth === undefined;
}
