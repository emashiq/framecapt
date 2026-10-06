import type { Rect } from '../../shared/rect';

/**
 * Shows one tile of a recorded mosaic with plain CSS: the whole video is laid inside a box that has
 * the tile's aspect ratio and clips its overflow, scaled and shifted so only the tile is visible.
 * It is the same decoded video for every tile (nothing is decoded again when the tile changes).
 * All values are percentages of the box (width, left) or of the box's height (height, top).
 */
export function tileCropStyle(
  tile: Rect,
  picture: { width: number; height: number },
): { width: string; height: string; left: string; top: string } {
  const pct = (value: number): string => `${Number((value * 100).toFixed(4))}%`;
  return {
    width: pct(picture.width / tile.width),
    height: pct(picture.height / tile.height),
    left: pct(-tile.x / tile.width),
    top: pct(-tile.y / tile.height),
  };
}
