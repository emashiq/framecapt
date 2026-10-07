import type { CameraShape, CameraSize } from '../../shared/camera';
import type { Rect } from '../../shared/rect';

export interface CameraLayerState {
  /** The center of the camera, 0..1 across the output. */
  nx: number;
  ny: number;
  size: CameraSize;
  shape: CameraShape;
  visible: boolean;
}

/** Corner radius of the rounded shape, as a fraction of the side. */
const ROUNDED_RADIUS = 0.22;

/**
 * Draws one camera frame into `rect` (a square) of a 2D canvas: the center square of the camera
 * picture, mirrored like the preview, clipped to a circle or rounded square, with a soft shadow and
 * a thin white ring. The shadow and the ring scale with the camera so they look the same at 720p
 * and 4K.
 */
export function drawCameraLayer(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  rect: Rect,
  shape: CameraShape,
): void {
  const { x, y, width: side } = rect;
  const frameWidth = video.videoWidth;
  const frameHeight = video.videoHeight;
  if (frameWidth === 0 || frameHeight === 0) return;
  const crop = Math.min(frameWidth, frameHeight);
  const ring = Math.max(2, Math.round(side * 0.02));

  const outline = (): void => {
    context.beginPath();
    if (shape === 'circle') context.arc(x + side / 2, y + side / 2, side / 2, 0, Math.PI * 2);
    else context.roundRect(x, y, side, side, side * ROUNDED_RADIUS);
  };

  context.save();
  // The shadow is cast by an opaque fill; the picture is drawn over it.
  outline();
  context.shadowColor = 'rgba(0, 0, 0, 0.38)';
  context.shadowBlur = side * 0.08;
  context.shadowOffsetY = side * 0.025;
  context.fillStyle = '#111';
  context.fill();
  context.shadowColor = 'transparent';

  outline();
  context.clip();
  context.translate(x + side, y);
  context.scale(-1, 1); // mirrored, so it matches the preview
  context.drawImage(
    video,
    (frameWidth - crop) / 2,
    (frameHeight - crop) / 2,
    crop,
    crop,
    0,
    0,
    side,
    side,
  );
  context.restore();

  context.save();
  outline();
  context.lineWidth = ring;
  context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  context.stroke();
  context.restore();
}
