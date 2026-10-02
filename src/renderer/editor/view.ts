import type { Point } from './model/types';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Space left around a fitted image, in CSS px. */
export const FIT_PADDING = 40;

/**
 * Where the image sits in the stage. `zoom` is DEVICE pixels per image pixel, so 1 (100%) shows
 * the capture 1:1 on the screen's own pixels at any devicePixelRatio. `panX`/`panY` are the CSS
 * pixel position of the image's top-left corner relative to the stage's top-left corner.
 */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export interface Size {
  width: number;
  height: number;
}

/** CSS pixels per image pixel. */
export function cssScale(view: View, dpr: number): number {
  return view.zoom / dpr;
}

/** Pointer position in the stage (CSS px) -> image px. The only such conversion in the editor. */
export function screenToImage(view: View, dpr: number, point: Point): Point {
  const scale = cssScale(view, dpr);
  return { x: (point.x - view.panX) / scale, y: (point.y - view.panY) / scale };
}

export function imageToScreen(view: View, dpr: number, point: Point): Point {
  const scale = cssScale(view, dpr);
  return { x: point.x * scale + view.panX, y: point.y * scale + view.panY };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zooms to `zoom` keeping the image point under `anchor` (stage CSS px) where it is. */
export function zoomAt(view: View, dpr: number, zoom: number, anchor: Point): View {
  const next = clampZoom(zoom);
  const imagePoint = screenToImage(view, dpr, anchor);
  const scale = next / dpr;
  return {
    zoom: next,
    panX: anchor.x - imagePoint.x * scale,
    panY: anchor.y - imagePoint.y * scale,
  };
}

/** Centers the image in the stage at `zoom`. */
export function centerView(stage: Size, image: Size, zoom: number, dpr: number): View {
  const scale = zoom / dpr;
  return {
    zoom,
    panX: (stage.width - image.width * scale) / 2,
    panY: (stage.height - image.height * scale) / 2,
  };
}

/** Fit-to-view: as large as fits with padding, but never above 100%. */
export function fitView(stage: Size, image: Size, dpr: number): View {
  const availableWidth = Math.max(1, stage.width - 2 * FIT_PADDING);
  const availableHeight = Math.max(1, stage.height - 2 * FIT_PADDING);
  const fit = Math.min(
    (availableWidth * dpr) / image.width,
    (availableHeight * dpr) / image.height,
  );
  return centerView(stage, image, clampZoom(Math.min(1, fit)), dpr);
}

/**
 * Keeps at least `margin` CSS px of the image inside the stage so it can never be panned away.
 * An image smaller than the stage stays centered on that axis.
 */
export function clampPan(view: View, stage: Size, image: Size, dpr: number, margin = 80): View {
  const scale = cssScale(view, dpr);
  const clampAxis = (pan: number, stageSize: number, imageSize: number): number => {
    const size = imageSize * scale;
    if (size + 2 * margin <= stageSize) return (stageSize - size) / 2;
    return Math.min(stageSize - margin, Math.max(margin - size, pan));
  };
  return {
    zoom: view.zoom,
    panX: clampAxis(view.panX, stage.width, image.width),
    panY: clampAxis(view.panY, stage.height, image.height),
  };
}

/** Zoom steps for the +/- buttons and Ctrl+=/Ctrl+-: about 25 % per step on a log scale. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = direction === 1 ? zoom * 1.25 : zoom / 1.25;
  // Snap to exactly 100% when a step lands close to it.
  return clampZoom(Math.abs(next - 1) < 0.06 ? 1 : next);
}
