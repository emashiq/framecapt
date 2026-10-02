import { checkPixelRect, type Rect } from '../../shared/rect';
import { CaptureError } from './errors';
import { registerLoop, registerTrack } from './resource-registry';

export type CropMethod = 'canvas' | 'track-processor';
export type CanvasDriver = 'rvfc' | 'timer';

export interface CropStats {
  framesOut: number;
  /** Size of the frames that were produced (verifies the crop size). */
  outWidth: number;
  outHeight: number;
}

export interface CroppedStream {
  /** A video-only stream with the cropped picture. */
  readonly stream: MediaStream;
  readonly method: CropMethod;
  stats(): CropStats;
  /** Stops loops, readers, the helper video element and the output tracks. Idempotent. */
  dispose(): void;
}

function sourceTrack(displayStream: MediaStream): MediaStreamTrack {
  const track = displayStream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') {
    throw new CaptureError('source-gone', 'The display stream has no live video track.');
  }
  return track;
}

function assertInside(rect: Rect, width: number, height: number): void {
  const check = checkPixelRect(rect, { width, height });
  if (!check.ok) throw new CaptureError('unknown', `Invalid region: ${check.reason}`);
}

/**
 * Prototype A: canvas crop. A hidden <video> shows the display stream; frames are drawn, cropped,
 * into a canvas whose captureStream() is the recorded video.
 *
 * Driver 'rvfc' (default) draws on requestVideoFrameCallback, i.e. once per delivered source
 * frame, throttled to `fps`; because a static screen delivers fewer frames than `fps`, a keep-alive
 * timer redraws the latest frame when a whole interval passed without a draw.
 * Driver 'timer' draws on a self-correcting timer only. Neither depends on requestAnimationFrame,
 * which hidden windows throttle.
 */
export async function createCanvasCrop(
  displayStream: MediaStream,
  rect: Rect,
  fps: number,
  driver: CanvasDriver = 'rvfc',
): Promise<CroppedStream> {
  const track = sourceTrack(displayStream);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  // A separate MediaStream object sharing the same track: removing it never stops the track.
  video.srcObject = new MediaStream([track]);

  const unregisterLoops: (() => void)[] = [];
  let disposed = false;
  let output: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let keepAlive: ReturnType<typeof setTimeout> | undefined;
  let frameCallback: number | undefined;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (keepAlive !== undefined) clearTimeout(keepAlive);
    if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    video.pause();
    video.srcObject = null;
    output?.getTracks().forEach((outTrack) => outTrack.stop());
    unregisterLoops.forEach((unregister) => unregister());
    unregisterLoops.length = 0;
  };

  try {
    await video.play();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for a video frame')),
        5000,
      );
      video.requestVideoFrameCallback(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    assertInside(rect, video.videoWidth, video.videoHeight);

    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new CaptureError('unknown', 'Could not create a 2D canvas context.');

    const interval = 1000 / fps;
    let framesOut = 0;
    let lastDraw = -Infinity;
    const draw = (): void => {
      context.drawImage(
        video,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height,
      );
      framesOut += 1;
      lastDraw = performance.now();
      if (driver === 'rvfc') scheduleKeepAlive();
    };
    // Keep-alive: if no source frame arrives within one interval of the last draw, redraw the
    // latest frame. Every draw re-arms it, so the output never has a gap longer than one interval.
    const scheduleKeepAlive = (): void => {
      if (keepAlive !== undefined) clearTimeout(keepAlive);
      keepAlive = setTimeout(
        () => {
          if (!disposed) draw();
        },
        Math.max(0, lastDraw + interval - performance.now()),
      );
    };

    output = canvas.captureStream(fps);
    output.getTracks().forEach(registerTrack);

    if (driver === 'rvfc') {
      unregisterLoops.push(registerLoop('crop-rvfc'), registerLoop('crop-keepalive'));
      const onFrame = (): void => {
        if (disposed) return;
        if (performance.now() - lastDraw >= interval * 0.9) draw();
        frameCallback = video.requestVideoFrameCallback(onFrame);
      };
      frameCallback = video.requestVideoFrameCallback(onFrame);
      scheduleKeepAlive();
    } else {
      unregisterLoops.push(registerLoop('crop-timer'));
      const start = performance.now();
      let tick = 0;
      const step = (): void => {
        if (disposed) return;
        draw();
        tick += 1;
        timer = setTimeout(step, Math.max(0, start + tick * interval - performance.now()));
      };
      step();
    }

    return {
      stream: output,
      method: 'canvas',
      stats: () => ({ framesOut, outWidth: rect.width, outHeight: rect.height }),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/**
 * Prototype B: MediaStreamTrackProcessor -> new VideoFrame(frame, { visibleRect }) ->
 * MediaStreamTrackGenerator. No canvas and no timers: frames flow at the source's pace and are
 * cropped without a copy through 2D. The rectangle must be aligned to even values (chroma
 * subsampling) or VideoFrame construction throws.
 */
export function createTrackProcessorCrop(displayStream: MediaStream, rect: Rect): CroppedStream {
  if (
    typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined'
  ) {
    throw new CaptureError('unknown', 'MediaStreamTrackProcessor/Generator are not available.');
  }
  if ([rect.x, rect.y, rect.width, rect.height].some((value) => value % 2 !== 0)) {
    throw new CaptureError('unknown', 'Track-processor crop needs an even-aligned region.');
  }
  // No settings-based bounds check: getSettings() is unreliable here, and VideoFrame throws on a
  // visibleRect outside the real frame, which ends the pipe.
  const track = sourceTrack(displayStream);

  // A clone so that disposing the crop never touches the caller's display track.
  const input = registerTrack(track.clone());
  const generator = registerTrack(new MediaStreamTrackGenerator({ kind: 'video' }));
  const unregister = registerLoop('crop-track-processor');
  const abort = new AbortController();
  let framesOut = 0;
  let disposed = false;

  const cropper = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      try {
        controller.enqueue(new VideoFrame(frame, { visibleRect: rect }));
        framesOut += 1;
      } finally {
        frame.close();
      }
    },
  });
  const processor = new MediaStreamTrackProcessor({ track: input });
  processor.readable
    .pipeThrough(cropper, { signal: abort.signal })
    .pipeTo(generator.writable, { signal: abort.signal })
    .catch(() => undefined); // aborted on dispose, or the track ended

  return {
    stream: new MediaStream([generator]),
    method: 'track-processor',
    stats: () => ({ framesOut, outWidth: rect.width, outHeight: rect.height }),
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      input.stop();
      generator.stop();
      unregister();
    },
  };
}
