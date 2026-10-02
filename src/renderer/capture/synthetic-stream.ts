import { registerLoop, registerStream } from './resource-registry';

/**
 * A generated "display" for E2E builds ONLY (reached through a dynamic import guarded by
 * __FRAMELET_E2E__ and checked out of production bundles by scripts/check-no-mocks.mjs). It is a
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
  const draw = (): void => {
    const t = (performance.now() - started) / 1000;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${(t * 40) % 360} 70% 45%)`);
    gradient.addColorStop(1, `hsl(${(t * 40 + 120) % 360} 70% 25%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(((t * 200) % (width + 200)) - 200, height / 3, 200, height / 3);
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
