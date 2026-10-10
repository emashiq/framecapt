import { registerLoop, registerStream } from './resource-registry';

/** Low on purpose: a one-core CI runner spends a whole core on a 30 fps 1080p software pipeline. */
const SYNTHETIC_FPS = 10;

const PRIMARY_PALETTE = { from: 'hsl(220 70% 45%)', to: 'hsl(340 70% 25%)' };
/** The synthetic picture of a live panel: green. */
export const PANEL_PALETTE = { from: 'hsl(120 80% 40%)', to: 'hsl(150 80% 25%)' };

/**
 * A generated "display" for E2E builds ONLY (reached through a dynamic import guarded by
 * __FRAMECAPT_E2E__ and checked out of production bundles by scripts/check-no-mocks.mjs). It is a
 * canvas stream of the requested size with moving content, so the recorder pipeline (crop, scale,
 * MediaRecorder, chunk upload) runs for real without touching a screen.
 */
export function createSyntheticDisplayStream(
  width: number,
  height: number,
  /** Backdrop colors; a panel uses green so a test can tell it from the recording itself. */
  palette: { from: string; to: string } = PRIMARY_PALETTE,
): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('No 2D context for the synthetic display');
  const stream = registerStream(canvas.captureStream(SYNTHETIC_FPS));
  const track = stream.getVideoTracks()[0];
  const unregister = registerLoop('synthetic-display');
  const started = performance.now();
  // The backdrop is painted once. Only a small block moves, so a software VP8 encoder on a
  // one-core CI runner has little to encode (a full-frame gradient per frame starved it).
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, palette.from);
  gradient.addColorStop(1, palette.to);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  let lastX = -200;
  const draw = (): void => {
    const t = (performance.now() - started) / 1000;
    const x = Math.round(((t * 200) % (width + 200)) - 200);
    context.fillStyle = gradient;
    context.fillRect(lastX, height / 3, 200, height / 3);
    context.fillStyle = '#ffffff';
    context.fillRect(x, height / 3, 200, height / 3);
    lastX = x;
  };
  draw();
  const timer = setInterval(() => {
    if (!track || track.readyState === 'ended') {
      clearInterval(timer);
      unregister();
      return;
    }
    draw();
  }, 1000 / SYNTHETIC_FPS);
  return stream;
}
