import type { Size } from '../../shared/geometry';
import type { Rect } from '../../shared/rect';
import { fitWithin } from '../../shared/recording';
import { createCompositor, sourceTrack } from './compositor';
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
export function createCanvasCrop(
  displayStream: MediaStream,
  rect: Rect,
  fps: number,
  driver: CanvasDriver = 'rvfc',
): Promise<CroppedStream> {
  return createCanvasTransform(displayStream, { rect }, fps, driver);
}

export interface CanvasTransformOptions {
  /** Crop in pixels of the display frame. Undefined: the whole frame (its size can change). */
  rect?: Rect | undefined;
  /**
   * Fit the output inside this size (aspect kept, even sides, never upscaled); `null` keeps the
   * source size with even sides. Undefined: the output is exactly the crop rectangle (diagnostics).
   */
  limit?: Size | null | undefined;
}

/**
 * The canvas pipeline behind both region crops and recordings: draws the display stream (or a
 * region of it) into a canvas, scaled to fit `limit`, and exposes the canvas as a video stream. The
 * output size is fixed when the first frame arrives.
 */
export function createCanvasTransform(
  displayStream: MediaStream,
  options: CanvasTransformOptions,
  fps: number,
  driver: CanvasDriver = 'rvfc',
): Promise<CroppedStream> {
  const { rect } = options;
  return createCompositor({
    tiles: [
      {
        stream: displayStream,
        src: rect ? () => rect : undefined,
        dst: (out) => ({ x: 0, y: 0, width: out.width, height: out.height }),
      },
    ],
    outSize: ([frame]) => {
      const sourceSize: Size = rect ?? (frame as Size);
      return options.limit === undefined
        ? { width: sourceSize.width, height: sourceSize.height }
        : fitWithin(sourceSize, options.limit);
    },
    fps,
    driver,
  });
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
