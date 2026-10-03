import { registerLoop, registerStream } from './resource-registry';

/**
 * A generated "display" for E2E builds ONLY (reached through a dynamic import guarded by
 * __FRAMECAPT_E2E__ and checked out of production bundles by scripts/check-no-mocks.mjs). It is a
 * canvas stream of the requested size with moving content, so the recorder pipeline (crop, scale,
 * MediaRecorder, chunk upload) runs for real without touching a screen.
 */
export function createSyntheticDisplayStream(width: number, height: number): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('No 2D context for the synthetic display');
  const stream = registerStream(canvas.captureStream(30));
  const track = stream.getVideoTracks()[0];
  const unregister = registerLoop('synthetic-display');
  const started = performance.now();
  // The backdrop is painted once. Only a small block moves, so a software VP8 encoder on a
  // one-core CI runner has little to encode (a full-frame gradient per frame starved it).
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, 'hsl(220 70% 45%)');
  gradient.addColorStop(1, 'hsl(340 70% 25%)');
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
  }, 33);
  return stream;
}
