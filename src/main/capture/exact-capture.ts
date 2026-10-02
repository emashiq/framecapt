import { desktopCapturer, type NativeImage } from 'electron';
import type { DisplayInfo } from './types';

/** A full-size, pixel-exact PNG of a window. */
export interface ExactFrame {
  width: number;
  height: number;
  png: Buffer;
}

/** A full-size, pixel-exact screen image. Kept as a NativeImage: nothing is encoded until needed. */
export interface ScreenFrame {
  width: number;
  height: number;
  image: NativeImage;
}

export interface ScreenGrab {
  /** Verified frames, keyed by display id. */
  frames: Map<string, ScreenFrame>;
  /** Displays without a verified frame (no source, or a size different from the physical size). */
  fallback: string[];
  /** Time spent in desktopCapturer.getSources (the captures themselves). */
  ms: number;
}

/**
 * Screens through `desktopCapturer` thumbnails, requested at full size. The thumbnail is the
 * capturer's own bitmap (BGRA), so edges are pixel-exact, unlike a getDisplayMedia video frame
 * (4:2:0, about one pixel of chroma bleed on saturated edges). A thumbnail is only accepted when
 * its size equals the display's physical size exactly; otherwise the display is listed in
 * `fallback` and the caller uses the worker's getDisplayMedia frame for it.
 *
 * ONE `getSources` call serves all displays: Electron fits each thumbnail into the requested box
 * keeping its aspect ratio, so asking for the largest width and height across displays means no
 * display is downscaled.
 */
export async function grabScreensExact(displays: readonly DisplayInfo[]): Promise<ScreenGrab> {
  const started = performance.now();
  const frames = new Map<string, ScreenFrame>();
  const fallback: string[] = [];
  const width = Math.max(1, ...displays.map((display) => display.physicalSize.width));
  const height = Math.max(1, ...displays.map((display) => display.physicalSize.height));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  for (const display of displays) {
    const source =
      sources.find((candidate) => candidate.display_id === display.id) ??
      (displays.length === 1 && sources.length === 1 ? sources[0] : undefined);
    const size = source && verifiedSize(source.thumbnail, display.physicalSize);
    if (source && size) frames.set(display.id, { ...size, image: source.thumbnail });
    else fallback.push(display.id);
  }
  return { frames, fallback, ms: Math.round(performance.now() - started) };
}

/**
 * A window thumbnail requested at exactly `size` (the getDisplayMedia frame size). Pixel-exact when
 * the capturer returns precisely that size (`frame`); otherwise `frame` is undefined, the caller
 * keeps the video frame, and `thumbnailSize` says what the capturer returned instead.
 */
export async function grabWindowExact(
  sourceId: string,
  size: { width: number; height: number },
): Promise<{ frame?: ExactFrame; thumbnailSize?: { width: number; height: number } }> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: size,
    fetchWindowIcons: false,
  });
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source) return {};
  const exact = verifiedSize(source.thumbnail, size);
  return exact
    ? { frame: { ...exact, png: source.thumbnail.toPNG() } }
    : { thumbnailSize: source.thumbnail.getSize() };
}

/** The image's size when it equals `expected` exactly, otherwise undefined. */
function verifiedSize(
  image: NativeImage,
  expected: { width: number; height: number },
): { width: number; height: number } | undefined {
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  if (size.width !== expected.width || size.height !== expected.height) return undefined;
  return { width: size.width, height: size.height };
}
