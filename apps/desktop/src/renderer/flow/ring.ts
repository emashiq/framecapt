import { RING_COLOR, ringGeometry } from '../../shared/flow';

const accent = (alpha: number): string =>
  `rgba(${RING_COLOR.r}, ${RING_COLOR.g}, ${RING_COLOR.b}, ${alpha})`;

/**
 * Draws the pointer ring on a 2D canvas: a soft accent fill, the accent stroke and a white halo
 * (the same picture `drawRing` burns into the History thumbnail). `scale` maps image pixels to
 * canvas pixels, so the ring keeps its size relative to the picture at any zoom.
 */
export function drawPointerRing(
  ctx: CanvasRenderingContext2D,
  cursor: { x: number; y: number },
  imageWidth: number,
  scale: number,
): void {
  const geometry = ringGeometry(imageWidth);
  const radius = geometry.radius * scale;
  const stroke = Math.max(1.5, geometry.stroke * scale);
  const halo = Math.max(1, stroke / 2);
  const x = cursor.x * scale;
  const y = cursor.y * scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = accent(0.18);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, radius + stroke + halo / 2, 0, Math.PI * 2);
  ctx.lineWidth = halo;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius + stroke / 2, 0, Math.PI * 2);
  ctx.lineWidth = stroke;
  ctx.strokeStyle = accent(1);
  ctx.stroke();
  ctx.restore();
}
