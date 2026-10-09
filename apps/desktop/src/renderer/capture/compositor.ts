import { cameraRect, fitInside, fitSnap, slotRects } from '../../shared/compositor-layout';
import type { Size } from '../../shared/geometry';
import { SOURCE_ENDED_TEXT, tileCardText, type PanelPlaceholder } from '../../shared/panels';
import { checkPixelRect, type Rect } from '../../shared/rect';
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
  /**
   * Draw the whole frame fitted (letterboxed, centered) inside `dst`, whatever size it has right
   * now: a window can be resized while it is recorded.
   */
  fit?: boolean | undefined;
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
  /**
   * A tile's video track ended (the screen was unplugged, the window closed): from then on its
   * rectangle shows a neutral "Source ended" tile and the others keep recording.
   */
  onTileLost?: ((index: number) => void) | undefined;
  /** The webcam overlay: drawn last, on top of every tile. */
  camera?: CompositorCamera | undefined;
}

interface DrawTile {
  video: HTMLVideoElement;
  src: CompositorTile['src'];
  dst: Rect;
  fit: boolean;
  lost: boolean;
}

/** A neutral card with one line of text: stands in for a source that ended or is hidden. */
function drawCard(context: CanvasRenderingContext2D, box: Rect, text: string): void {
  context.fillStyle = '#20242c';
  context.fillRect(box.x, box.y, box.width, box.height);
  context.fillStyle = '#9aa3b2';
  context.font = `${Math.max(12, Math.round(box.height / 16))}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, box.x + box.width / 2, box.y + box.height / 2, box.width - 8);
}

/** A hidden <video> that shows the track (a separate MediaStream sharing it: removing it never stops the track). */
function makeVideo(track: MediaStreamTrack): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  return video;
}

function closeVideo(video: HTMLVideoElement): void {
  video.pause();
  video.srcObject = null;
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

/** Plays a video and waits for its first frame. */
async function startVideo(video: HTMLVideoElement): Promise<void> {
  await video.play();
  await waitForFrame(video);
}

/** Throws when a tile's crop does not lie inside its source frame. */
function checkCrop(crop: Rect | undefined, source: Size): void {
  if (!crop) return;
  const check = checkPixelRect(crop, source);
  if (!check.ok) throw new CaptureError('unknown', `Invalid region: ${check.reason}`);
}

/**
 * Draws the source frame (or its `src` part) into `dst`; `fit` letterboxes it inside `dst`.
 * No object is made per frame when there is no crop.
 */
function drawVideoTile(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  src: ((source: Size) => Rect | undefined) | undefined,
  dst: Rect,
  fit: 'none' | 'fit' | 'snap',
): void {
  const crop = src?.({ width: video.videoWidth, height: video.videoHeight });
  const frame = crop ?? { width: video.videoWidth, height: video.videoHeight };
  const box = fit === 'none' ? dst : fit === 'snap' ? fitSnap(frame, dst) : fitInside(frame, dst);
  context.drawImage(
    video,
    crop ? crop.x : 0,
    crop ? crop.y : 0,
    frame.width,
    frame.height,
    box.x,
    box.y,
    box.width,
    box.height,
  );
}

function drawCamera(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  state: CameraLayerState,
  out: Size,
): void {
  if (state.visible) {
    drawCameraLayer(context, video, cameraRect(state, out, state.size), state.shape);
  }
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
  const tracks = tiles.map((tile) => sourceTrack(tile.stream));
  const videos = tracks.map(makeVideo);
  const primary = videos[0] as HTMLVideoElement;
  const cameraVideo = options.camera ? makeVideo(sourceTrack(options.camera.stream)) : undefined;
  const cameraState = options.camera?.state;

  const unregisterLoops: (() => void)[] = [];
  const endedListeners: (() => void)[] = [];
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
    endedListeners.forEach((remove) => remove());
    for (const video of cameraVideo ? [...videos, cameraVideo] : videos) closeVideo(video);
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
      checkCrop(tile.src?.(source), source);
      return {
        video: videos[index] as HTMLVideoElement,
        src: tile.src,
        dst: typeof tile.dst === 'function' ? tile.dst(outSize, source) : tile.dst,
        fit: tile.fit === true,
        lost: false,
      };
    });
    tracks.forEach((track, index) => {
      const onEnded = (): void => {
        const drawTile = drawTiles[index];
        if (!drawTile || drawTile.lost) return;
        drawTile.lost = true;
        options.onTileLost?.(index);
      };
      track.addEventListener('ended', onEnded);
      endedListeners.push(() => track.removeEventListener('ended', onEnded));
      if (track.readyState === 'ended') onEnded();
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
        if (tile.lost) {
          drawCard(context, tile.dst, SOURCE_ENDED_TEXT);
          continue;
        }
        drawVideoTile(context, tile.video, tile.src, tile.dst, tile.fit ? 'fit' : 'none');
      }
      if (cameraVideo && cameraState) drawCamera(context, cameraVideo, cameraState(), outSize);
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

// --- live panels ----------------------------------------------------------------------------

export interface DynamicTileOptions {
  /** The part of the source frame to draw (see CompositorTile.src); validated when the first frame arrives. */
  src?: ((source: Size) => Rect | undefined) | undefined;
  /** Letterbox the picture inside its rectangle. Default true. */
  fit?: boolean | undefined;
}

export interface DynamicCompositorOptions {
  /** Slot 0: the recording itself. Its first frame fixes the output size. */
  primary: DynamicTileOptions & { stream: MediaStream };
  outSize: (primary: Size) => Size;
  fps: number;
  /** A tile's video track ended. The tile shows "Source ended" until the caller detaches it. */
  onTileLost?: ((slot: number) => void) | undefined;
  /** The webcam overlay: drawn last, on top of every tile. */
  camera?: CompositorCamera | undefined;
}

export interface TileInfo {
  slot: number;
  lost: boolean;
  hidden: boolean;
  /** Where the tile sits on the output right now. */
  dst: Rect;
}

export interface DynamicCompositor extends CroppedStream {
  /**
   * Puts a stream into a slot (replacing what was there) once its first frame arrived (5 s, else
   * rejects), then lays the output out again. Never leaves a gap: the old tile is drawn until
   * the swap.
   */
  attachTile(slot: number, stream: MediaStream, options?: DynamicTileOptions): Promise<void>;
  /** Removes a tile and lays out again. Never stops the stream's tracks: the caller owns the stream. */
  detachTile(slot: number): void;
  /** While hidden the tile's rectangle shows a neutral card; its (stale) video frame is never drawn. */
  setTileHidden(slot: number, hidden: boolean, placeholder: PanelPlaceholder): void;
  slots(): TileInfo[];
  /** True when a new frame of the slot's source arrives within `timeoutMs`. */
  waitForFrame(slot: number, timeoutMs: number): Promise<boolean>;
}

interface DynamicTile {
  video: HTMLVideoElement;
  src: DynamicTileOptions['src'];
  fit: boolean;
  dst: Rect;
  lost: boolean;
  hidden: boolean;
  placeholder: PanelPlaceholder | null;
  removeEnded: () => void;
}

/**
 * The compositor of a recording that can gain and lose pictures while it runs: slot 0 is the
 * recording, slots 1..3 are panels (see `panelLayout`). The output size is fixed by the first frame
 * of slot 0. It always draws on a self-correcting timer (never on the frame callback of one video:
 * that video may be swapped), at a constant `fps`; the canvas stream is the result.
 */
export async function createDynamicCompositor(
  options: DynamicCompositorOptions,
): Promise<DynamicCompositor> {
  const cameraVideo = options.camera ? makeVideo(sourceTrack(options.camera.stream)) : undefined;
  const cameraState = options.camera?.state;
  const tiles = new Map<number, DynamicTile>();
  const unregisterLoops: (() => void)[] = [];
  let disposed = false;
  let output: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outSize: Size | undefined;

  const closeTile = (tile: DynamicTile): void => {
    tile.removeEnded();
    closeVideo(tile.video);
  };

  const layout = (): void => {
    if (!outSize) return;
    const rects = slotRects(outSize, [...tiles.keys()]);
    for (const [slot, tile] of tiles) tile.dst = rects.get(slot) as Rect;
  };

  /** A tile with a playing video and a first frame; not yet part of the picture. */
  const openTile = async (
    stream: MediaStream,
    tileOptions: DynamicTileOptions,
  ): Promise<DynamicTile> => {
    const video = makeVideo(sourceTrack(stream));
    try {
      await startVideo(video);
      const frame = { width: video.videoWidth, height: video.videoHeight };
      checkCrop(tileOptions.src?.(frame), frame);
    } catch (error) {
      closeVideo(video);
      throw error;
    }
    return {
      video,
      src: tileOptions.src,
      fit: tileOptions.fit !== false,
      dst: { x: 0, y: 0, width: 0, height: 0 },
      lost: false,
      hidden: false,
      placeholder: null,
      removeEnded: () => undefined,
    };
  };

  const insert = (slot: number, tile: DynamicTile, stream: MediaStream): void => {
    const track = sourceTrack(stream);
    const onEnded = (): void => {
      if (tile.lost || tiles.get(slot) !== tile) return;
      tile.lost = true;
      options.onTileLost?.(slot);
    };
    track.addEventListener('ended', onEnded);
    tile.removeEnded = () => track.removeEventListener('ended', onEnded);
    const previous = tiles.get(slot);
    tiles.set(slot, tile);
    if (previous) closeTile(previous);
    layout();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const tile of tiles.values()) closeTile(tile);
    tiles.clear();
    if (cameraVideo) closeVideo(cameraVideo);
    output?.getTracks().forEach((outTrack) => outTrack.stop());
    unregisterLoops.forEach((unregister) => unregister());
    unregisterLoops.length = 0;
  };

  try {
    const [primary] = await Promise.all([
      openTile(options.primary.stream, options.primary),
      cameraVideo ? startVideo(cameraVideo) : undefined,
    ]);
    const out = options.outSize({
      width: primary.video.videoWidth,
      height: primary.video.videoHeight,
    });
    outSize = out;
    insert(0, primary, options.primary.stream);

    const canvas = document.createElement('canvas');
    canvas.width = out.width;
    canvas.height = out.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new CaptureError('unknown', 'Could not create a 2D canvas context.');
    context.imageSmoothingQuality = 'medium';

    let framesOut = 0;
    const draw = (): void => {
      // Gaps and letterbox bars are black.
      context.fillStyle = '#000';
      context.fillRect(0, 0, out.width, out.height);
      for (const tile of tiles.values()) {
        const card = tileCardText(tile);
        if (card !== null) drawCard(context, tile.dst, card);
        else drawVideoTile(context, tile.video, tile.src, tile.dst, tile.fit ? 'snap' : 'none');
      }
      if (cameraVideo && cameraState) drawCamera(context, cameraVideo, cameraState(), out);
      framesOut += 1;
    };

    output = canvas.captureStream(options.fps);
    output.getTracks().forEach(registerTrack);
    unregisterLoops.push(registerLoop('crop-timer'));
    const interval = 1000 / options.fps;
    const start = performance.now();
    let tick = 0;
    const step = (): void => {
      if (disposed) return;
      draw();
      tick += 1;
      timer = setTimeout(step, Math.max(0, start + tick * interval - performance.now()));
    };
    step();

    return {
      stream: output,
      method: 'canvas',
      stats: () => ({ framesOut, outWidth: out.width, outHeight: out.height }),
      dispose,
      async attachTile(slot, stream, tileOptions = {}) {
        const tile = await openTile(stream, tileOptions);
        if (disposed) {
          closeVideo(tile.video);
          throw new CaptureError('unknown', 'The recording has ended.');
        }
        insert(slot, tile, stream);
        if (stream.getVideoTracks()[0]?.readyState === 'ended') {
          tile.lost = true;
          options.onTileLost?.(slot);
        }
      },
      detachTile(slot) {
        const tile = tiles.get(slot);
        if (!tile) return;
        tiles.delete(slot);
        closeTile(tile);
        layout();
      },
      setTileHidden(slot, hidden, placeholder) {
        const tile = tiles.get(slot);
        if (!tile) return;
        tile.hidden = hidden;
        tile.placeholder = hidden ? placeholder : null;
      },
      slots: () =>
        [...tiles.entries()].map(([slot, tile]) => ({
          slot,
          lost: tile.lost,
          hidden: tile.hidden,
          dst: tile.dst,
        })),
      waitForFrame(slot, timeoutMs) {
        const tile = tiles.get(slot);
        if (!tile) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), timeoutMs);
          tile.video.requestVideoFrameCallback(() => {
            clearTimeout(timeout);
            resolve(true);
          });
        });
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
