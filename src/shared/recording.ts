import type { Size } from './geometry';

/** Quality presets of the record options. "1080p" fits the picture inside 1920 x 1080. */
export const QUALITY_VALUES = ['1080p', 'source'] as const;
export type RecordQuality = (typeof QUALITY_VALUES)[number];

export const FPS_VALUES = [30, 60] as const;
export type RecordFps = (typeof FPS_VALUES)[number];

export const MAX_1080P: Size = { width: 1920, height: 1080 };

/** Round to the nearest even integer, never below 2 (4:2:0 video needs even sides). */
export function nearestEven(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}

export function floorEven(value: number): number {
  return Math.max(2, 2 * Math.floor(value / 2));
}

/**
 * The size of the recorded video for a source of `source` pixels: unchanged (rounded down to even
 * sides) when it already fits `limit`, otherwise scaled down to fit, keeping the aspect ratio, to
 * even sides. `limit === null` is the "source resolution" preset. Never upscales.
 */
export function fitWithin(source: Size, limit: Size | null): Size {
  if (limit === null || (source.width <= limit.width && source.height <= limit.height)) {
    return { width: floorEven(source.width), height: floorEven(source.height) };
  }
  const scale = Math.min(limit.width / source.width, limit.height / source.height);
  let width = nearestEven(source.width * scale);
  let height = nearestEven(source.height * scale);
  if (width > limit.width) width -= 2;
  if (height > limit.height) height -= 2;
  return { width: Math.max(2, width), height: Math.max(2, height) };
}

export function qualityLimit(quality: RecordQuality): Size | null {
  return quality === '1080p' ? MAX_1080P : null;
}

/** About 8 Mbps for 1920 x 1080 at 30 fps, scaled with pixels and frame rate, within 2.5-30 Mbps. */
export function videoBitrate(size: Size, fps: number): number {
  const scaled = 8_000_000 * ((size.width * size.height) / (1920 * 1080)) * (fps / 30);
  return Math.round(Math.min(30_000_000, Math.max(2_500_000, scaled)));
}

export const AUDIO_BITRATE = 128_000;

/** "03:07" or, from one hour on, "1:03:07". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

/** "Framelet 2026-10-02 at 14.05.09.webm" in local time (colons are not allowed in file names). */
export function defaultRecordingFileName(date: Date, extension = 'webm'): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const time = `${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
  return `Framelet ${day} at ${time}.${extension}`;
}

/** Inserts " (2)", " (3)" ... before the extension for the n-th collision (n starts at 1). */
export function withCollisionSuffix(fileName: string, attempt: number): string {
  if (attempt <= 0) return fileName;
  const dot = fileName.lastIndexOf('.');
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  const extension = dot === -1 ? '' : fileName.slice(dot);
  return `${stem} (${attempt + 1})${extension}`;
}

/** "12.3 MB" style size for the result badges. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
