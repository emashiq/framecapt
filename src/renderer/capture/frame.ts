import { CaptureError } from './errors';

export type FrameMethod = 'video-element' | 'track-processor' | 'image-capture';

/** `auto` (the default) tries track-processor first and falls back to video-element. */
export type FrameMethodChoice = FrameMethod | 'auto';

export const FRAME_METHODS: readonly FrameMethodChoice[] = [
  'auto',
  'video-element',
  'track-processor',
  'image-capture',
];

export interface FullResolutionFrame {
  /** Pixel size of the PNG. Always the size of the captured frame, never scaled. */
  width: number;
  height: number;
  /** track.getSettings() size before and after the first frame. Observed to be unreliable for the
   *  secondary monitor (reports another display's size), so the frame itself is the truth. */
  settingsBefore: { width: number | undefined; height: number | undefined };
  settingsAfter: { width: number | undefined; height: number | undefined };
  blob: Blob;
  method: FrameMethod;
  /** From the start of the grab to the first decoded frame. */
  firstFrameMs: number;
  /** Whole grab, including PNG encoding. */
  totalMs: number;
}

const FRAME_TIMEOUT_MS = 5000;

async function frameFromVideoElement(stream: MediaStream): Promise<ImageBitmap> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for a video frame')),
        FRAME_TIMEOUT_MS,
      );
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // createImageBitmap copies the current frame at its intrinsic (videoWidth x videoHeight) size.
    return await createImageBitmap(video);
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

async function frameFromTrackProcessor(track: MediaStreamTrack): Promise<ImageBitmap> {
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    throw new Error('MediaStreamTrackProcessor is not available');
  }
  const reader = new MediaStreamTrackProcessor({ track: track.clone() }).readable.getReader();
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for a video frame')), FRAME_TIMEOUT_MS),
    );
    const { value: frame } = await Promise.race([reader.read(), timeout]);
    if (!frame) throw new Error('Track ended before a frame arrived');
    try {
      return await createImageBitmap(frame);
    } finally {
      frame.close();
    }
  } finally {
    // Cancelling stops the cloned track too (the processor owns it).
    await reader.cancel().catch(() => undefined);
  }
}

async function frameFromImageCapture(track: MediaStreamTrack): Promise<ImageBitmap> {
  if (typeof ImageCapture === 'undefined') throw new Error('ImageCapture is not available');
  return new ImageCapture(track).grabFrame();
}

/**
 * Grabs one frame from a live display stream at the stream's own resolution and encodes it as
 * PNG. Never scales: the canvas is exactly the frame's size. A small thumbnail is never upscaled
 * to stand in for the real frame. The stream is left running (the caller releases it).
 */
export async function grabFullResolutionFrame(
  stream: MediaStream,
  choice: FrameMethodChoice = 'auto',
): Promise<FullResolutionFrame> {
  if (choice !== 'auto') return grabWith(stream, choice);
  try {
    return await grabWith(stream, 'track-processor');
  } catch {
    return grabWith(stream, 'video-element');
  }
}

async function grabWith(stream: MediaStream, method: FrameMethod): Promise<FullResolutionFrame> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') {
    throw new CaptureError('source-gone', 'The capture stream has no live video track.');
  }
  const settingsBefore = track.getSettings();
  const started = performance.now();

  let bitmap: ImageBitmap;
  try {
    bitmap =
      method === 'track-processor'
        ? await frameFromTrackProcessor(track)
        : method === 'image-capture'
          ? await frameFromImageCapture(track)
          : await frameFromVideoElement(stream);
  } catch (error) {
    throw new CaptureError(
      'unknown',
      `Could not read a frame (${method}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const firstFrameMs = performance.now() - started;

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new CaptureError('unknown', 'Could not create a 2D canvas context.');
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      settingsBefore: { width: settingsBefore.width, height: settingsBefore.height },
      settingsAfter: { width: track.getSettings().width, height: track.getSettings().height },
      blob,
      method,
      firstFrameMs,
      totalMs: performance.now() - started,
    };
  } finally {
    bitmap.close();
  }
}
