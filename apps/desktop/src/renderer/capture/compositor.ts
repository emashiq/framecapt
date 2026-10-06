import type { Size } from '../../shared/geometry';
import { checkPixelRect, type Rect } from '../../shared/rect';
import { cameraRect } from '../../shared/compositor-layout';
import { CaptureError } from './errors';
import { drawCameraLayer, type CameraLayerState } from './camera-layer';
import type { CanvasDriver, CroppedStream } from './region-crop';
import { registerLoop, registerTrack } from './resource-registry';

export function sourceTrack(displayStream: MediaStream): MediaStreamTrack {
  const track = displayStream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') {
    throw new CaptureError('source-gone', 'The display stream has no live video track.');
  }
  return track;
}

export interface CompositorTile {
  stream: MediaStream;
  /**
   * The part of the source frame to draw, in source pixels, asked again on every tick (a follow
   * window moves). Undefined, or returning undefined: the whole frame. It is checked against the
   * frame once, when the first frame arrives.
   */
  src?: ((source: Size) => Rect | undefined) | undefined;
  /** Where the tile goes on the output. A function gets the output and the source frame size. */
  dst: Rect | ((out: Size, source: Size) => Rect);
}

export interface CompositorCamera {
  stream: MediaStream;
  /** Asked on every tick (the bubble moves while recording). */
  state: () => CameraLayerState;
}

export interface CompositorOptions {
  /** Tiles are drawn in order, later ones on top. */
  tiles: readonly CompositorTile[];
  /**
   * The output size. A function is called once, when every tile has delivered its first frame,
   * with the frame size of each tile; the size then stays fixed.
   */
  outSize: Size | ((sources: readonly Size[]) => Size);
  fps: number;
  driver: CanvasDriver;
  /** The webcam overlay: drawn last, on top of every tile. */
  camera?: CompositorCamera | undefined;
}

interface DrawTile {
  video: HTMLVideoElement;
  src: CompositorTile['src'];
  dst: Rect;
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for a video frame')),
      5000,
    );
    video.requestVideoFrameCallback(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Draws the video of every tile into one canvas on each tick; the canvas' captureStream() is the
 * result. A hidden <video> shows each source stream.
 *
 * Driver 'rvfc' (default) draws on requestVideoFrameCallback of the first tile, i.e. once per
 * delivered source frame, throttled to `fps`; because a static screen delivers fewer frames than
 * `fps`, a keep-alive timer redraws the latest frames when a whole interval passed without a draw.
 * Driver 'timer' draws on a self-correcting timer only. Neither depends on requestAnimationFrame,
 * which hidden windows throttle.
 */
export async function createCompositor(options: CompositorOptions): Promise<CroppedStream> {
  const { tiles, fps, driver } = options;
  const first = tiles[0];
  if (!first) throw new CaptureError('unknown', 'A compositor needs at least one tile.');
  const makeVideo = (stream: MediaStream): HTMLVideoElement => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    // A separate MediaStream object sharing the same track: removing it never stops the track.
    video.srcObject = new MediaStream([sourceTrack(stream)]);
    return video;
  };
  const videos = tiles.map((tile) => makeVideo(tile.stream));
  const primary = videos[0] as HTMLVideoElement;
  const cameraVideo = options.camera ? makeVideo(options.camera.stream) : undefined;
  const cameraState = options.camera?.state;

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
    if (frameCallback !== undefined) primary.cancelVideoFrameCallback(frameCallback);
    for (const video of cameraVideo ? [...videos, cameraVideo] : videos) {
      video.pause();
      video.srcObject = null;
    }
    output?.getTracks().forEach((outTrack) => outTrack.stop());
    unregisterLoops.forEach((unregister) => unregister());
    unregisterLoops.length = 0;
  };

  try {
    const all = cameraVideo ? [...videos, cameraVideo] : videos;
    await Promise.all(all.map((video) => video.play()));
    await Promise.all(all.map(waitForFrame));
    const sources = videos.map((video) => ({ width: video.videoWidth, height: video.videoHeight }));
    const outSize =
      typeof options.outSize === 'function' ? options.outSize(sources) : options.outSize;
    const drawTiles: DrawTile[] = tiles.map((tile, index) => {
      const source = sources[index] as Size;
      const crop = tile.src?.(source);
      if (crop) {
        const check = checkPixelRect(crop, source);
        if (!check.ok) throw new CaptureError('unknown', `Invalid region: ${check.reason}`);
      }
      return {
        video: videos[index] as HTMLVideoElement,
        src: tile.src,
        dst: typeof tile.dst === 'function' ? tile.dst(outSize, source) : tile.dst,
      };
    });

    const canvas = document.createElement('canvas');
    canvas.width = outSize.width;
    canvas.height = outSize.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new CaptureError('unknown', 'Could not create a 2D canvas context.');

    const interval = 1000 / fps;
    let framesOut = 0;
    let lastDraw = -Infinity;
    context.imageSmoothingQuality = 'medium';
    const draw = (): void => {
      // A mosaic leaves gaps between tiles: start from black. One tile covers everything.
      if (drawTiles.length > 1) {
        context.fillStyle = '#000';
        context.fillRect(0, 0, outSize.width, outSize.height);
      }
      for (const tile of drawTiles) {
        const { video, dst } = tile;
        // No object is made per frame: the whole frame is read from the element when there is no crop.
        const crop = tile.src?.({ width: video.videoWidth, height: video.videoHeight });
        context.drawImage(
          video,
          crop ? crop.x : 0,
          crop ? crop.y : 0,
          crop ? crop.width : video.videoWidth,
          crop ? crop.height : video.videoHeight,
          dst.x,
          dst.y,
          dst.width,
          dst.height,
        );
      }
      if (cameraVideo && cameraState) {
        const state = cameraState();
        if (state.visible) {
          drawCameraLayer(
            context,
            cameraVideo,
            cameraRect(state, outSize, state.size),
            state.shape,
          );
        }
      }
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
        frameCallback = primary.requestVideoFrameCallback(onFrame);
      };
      frameCallback = primary.requestVideoFrameCallback(onFrame);
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
      stats: () => ({ framesOut, outWidth: outSize.width, outHeight: outSize.height }),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
