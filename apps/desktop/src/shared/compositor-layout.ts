import type { CameraSize } from './camera';
import type { Size } from './geometry';
import type { Rect } from './rect';
import { floorEven } from './recording';

/** Zoom factors of the follow-mouse recording. */
export const FOLLOW_ZOOMS = [1.5, 2, 3] as const;
export type FollowZoom = (typeof FOLLOW_ZOOMS)[number];

/** How fast the follow window catches up with the mouse (63 % of the distance per this time). */
const FOLLOW_TIME_CONSTANT_MS = 180;
/** The mouse may wander this far (fraction of the crop size) from the center before it pans. */
const FOLLOW_DEAD_ZONE = 0.1;

const evenDown = (value: number): number => 2 * Math.floor(value / 2);

/** Size of the follow window: the frame divided by the zoom, even sides. */
export function followCropSize(frame: Size, zoom: FollowZoom): Size {
  return { width: floorEven(frame.width / zoom), height: floorEven(frame.height / zoom) };
}

export interface FollowCropInput {
  /** The mouse, in pixels of the source frame. */
  target: { x: number; y: number };
  /** The previous crop (null on the first tick: the window starts centered on the mouse). */
  prev: Rect | null;
  /** Time since the previous tick. */
  dtMs: number;
  zoom: FollowZoom;
  /** Size of the source frame in pixels. */
  frame: Size;
}

/**
 * The crop of the next frame of a follow-mouse recording. The window's center eases toward the
 * mouse with exponential smoothing (frame-rate independent); inside a dead zone around the center
 * it does not move at all, so tiny jitters do not pan. The result is clamped inside the frame. Its
 * size is even (4:2:0 video); its position stays sub-pixel so slow pans glide instead of stepping.
 */
export function followCrop(input: FollowCropInput): Rect {
  const { target, prev, dtMs, zoom, frame } = input;
  const size = followCropSize(frame, zoom);
  let cx = target.x;
  let cy = target.y;
  if (prev) {
    const px = prev.x + prev.width / 2;
    const py = prev.y + prev.height / 2;
    const alpha = 1 - Math.exp(-Math.max(0, dtMs) / FOLLOW_TIME_CONSTANT_MS);
    cx = px + (aimAt(target.x, px, size.width * FOLLOW_DEAD_ZONE) - px) * alpha;
    cy = py + (aimAt(target.y, py, size.height * FOLLOW_DEAD_ZONE) - py) * alpha;
  }
  const x = Math.min(Math.max(0, cx - size.width / 2), Math.max(0, frame.width - size.width));
  const y = Math.min(Math.max(0, cy - size.height / 2), Math.max(0, frame.height - size.height));
  return { x, y, ...size };
}

/** Where the center heads: it stays put while the mouse is inside the dead zone, else it aims at the zone's edge. */
function aimAt(target: number, center: number, deadZone: number): number {
  const offset = target - center;
  if (Math.abs(offset) <= deadZone) return center;
  return target - Math.sign(offset) * deadZone;
}

// --- mosaic ---------------------------------------------------------------------------------

export interface MosaicTile {
  width: number;
  height: number;
  /** Position on the virtual desktop ('virtual' mode). */
  x?: number;
  y?: number;
}

export interface MosaicLimit {
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

export interface MosaicLayout {
  /** Output size, even sides, within the limit. */
  width: number;
  height: number;
  /** Where each tile is drawn, in the order of the input. Even aligned, inside the output. */
  rects: Rect[];
}

/**
 * Lays tiles out on one canvas. 'virtual' keeps their positions on the virtual desktop (the
 * bounding box of all tiles); 'grid' arranges them in a near-square grid of equal cells, each tile
 * centered in its cell at its own aspect ratio. The canvas is scaled down (never up) to fit the limit.
 */
export function mosaicLayout(
  tiles: readonly MosaicTile[],
  mode: 'virtual' | 'grid',
  limit: MosaicLimit,
): MosaicLayout {
  if (tiles.length === 0) return { width: 2, height: 2, rects: [] };
  const { size, rects } = mode === 'virtual' ? placeVirtual(tiles) : placeGrid(tiles);
  const scale = Math.min(
    1,
    limit.maxWidth / size.width,
    limit.maxHeight / size.height,
    Math.sqrt(limit.maxPixels / (size.width * size.height)),
  );
  const width = floorEven(size.width * scale);
  const height = floorEven(size.height * scale);
  return {
    width,
    height,
    rects: rects.map((rect) => {
      const w = Math.min(width, floorEven(rect.width * scale));
      const h = Math.min(height, floorEven(rect.height * scale));
      return {
        x: Math.min(width - w, evenDown(Math.round(rect.x * scale))),
        y: Math.min(height - h, evenDown(Math.round(rect.y * scale))),
        width: w,
        height: h,
      };
    }),
  };
}

function placeVirtual(tiles: readonly MosaicTile[]): { size: Size; rects: Rect[] } {
  const left = Math.min(...tiles.map((tile) => tile.x ?? 0));
  const top = Math.min(...tiles.map((tile) => tile.y ?? 0));
  const right = Math.max(...tiles.map((tile) => (tile.x ?? 0) + tile.width));
  const bottom = Math.max(...tiles.map((tile) => (tile.y ?? 0) + tile.height));
  return {
    size: { width: right - left, height: bottom - top },
    rects: tiles.map((tile) => ({
      x: (tile.x ?? 0) - left,
      y: (tile.y ?? 0) - top,
      width: tile.width,
      height: tile.height,
    })),
  };
}

function placeGrid(tiles: readonly MosaicTile[]): { size: Size; rects: Rect[] } {
  const columns = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / columns);
  const cellWidth = Math.max(...tiles.map((tile) => tile.width));
  const cellHeight = Math.max(...tiles.map((tile) => tile.height));
  return {
    size: { width: columns * cellWidth, height: rows * cellHeight },
    rects: tiles.map((tile, index) => {
      const fit = Math.min(cellWidth / tile.width, cellHeight / tile.height);
      const width = Math.round(tile.width * fit);
      const height = Math.round(tile.height * fit);
      return {
        x: (index % columns) * cellWidth + Math.round((cellWidth - width) / 2),
        y: Math.floor(index / columns) * cellHeight + Math.round((cellHeight - height) / 2),
        width,
        height,
      };
    }),
  };
}

// --- camera overlay -------------------------------------------------------------------------

/** Side of the camera as a fraction of the output's shorter side. */
const CAMERA_SIZE: Record<CameraSize, number> = { s: 0.14, m: 0.2, l: 0.28 };
const CAMERA_MARGIN = 0.02;

/**
 * Where the webcam picture goes: a square (clipped to a circle or rounded square when drawn)
 * centered on the normalized point (nx, ny of the output), the size chosen by `size`, and kept
 * inside the output with a small margin. Even aligned.
 */
export function cameraRect(center: { nx: number; ny: number }, out: Size, size: CameraSize): Rect {
  const shorter = Math.min(out.width, out.height);
  const side = floorEven(shorter * CAMERA_SIZE[size]);
  const margin = evenDown(shorter * CAMERA_MARGIN);
  const maxX = Math.max(margin, out.width - side - margin);
  const maxY = Math.max(margin, out.height - side - margin);
  const x = Math.min(Math.max(margin, center.nx * out.width - side / 2), maxX);
  const y = Math.min(Math.max(margin, center.ny * out.height - side / 2), maxY);
  return { x: evenDown(Math.round(x)), y: evenDown(Math.round(y)), width: side, height: side };
}
