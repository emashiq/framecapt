import { registerLoop } from './resource-registry';

export interface FrameCounter {
  /** Frames presented since start. */
  count(): number;
  /** Milliseconds since start. */
  elapsedMs(): number;
  /** Intrinsic size of the presented video (the real frame size). */
  size(): { width: number; height: number };
  stop(): void;
}

/**
 * Counts frames actually delivered by a video track by presenting it in an off-screen <video> and
 * counting requestVideoFrameCallback calls. Diagnostics only: it adds a decode path of its own.
 */
export async function startFrameCounter(track: MediaStreamTrack): Promise<FrameCounter> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  const unregister = registerLoop('frame-counter');
  let frames = 0;
  let stopped = false;
  let callback: number | undefined;
  let started = performance.now();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    video.pause();
    video.srcObject = null;
    unregister();
  };

  const onFrame = (): void => {
    if (stopped) return;
    frames += 1;
    callback = video.requestVideoFrameCallback(onFrame);
  };

  try {
    await video.play();
  } catch (error) {
    stop();
    throw error;
  }
  started = performance.now();
  callback = video.requestVideoFrameCallback(onFrame);

  return {
    count: () => frames,
    elapsedMs: () => performance.now() - started,
    size: () => ({ width: video.videoWidth, height: video.videoHeight }),
    stop,
  };
}
