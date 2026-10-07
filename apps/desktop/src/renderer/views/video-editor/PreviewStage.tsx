import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  MIN_BOX_PX,
  MIN_CROP_PX,
  MIN_ITEM_MS,
  fadeAlpha,
  isVisual,
  newItem,
  newText,
  type Item,
  type MaskKind,
  type PixelRect,
  type TextItem,
  type VideoCommand,
  type VideoProject,
  type VisualItem,
} from '../../../shared/video-edit';
import { assetUrl } from './clip-spec';
import { drawTextItem, loadFontFor } from './text-draw';
import { fontOf } from './text-layout';
import { fileUrl, newNonce } from '../../history/media-url';
import { revealDuration } from '../../lib/reveal-duration';
import type { Player } from './player';
import {
  RESIZE_HANDLES,
  cursorFor,
  dragRect,
  handlePosition,
  hitHandle,
  rectAround,
  rectFromPoints,
  type Handle,
} from './rect-drag';

const STAGE_PADDING = 16;
/** A click on the preview with a tool makes a box of this fraction of the frame. */
const DEFAULT_BOX = { width: 0.25, height: 0.2 };
const DEFAULT_ITEM_MS = 3000;
const SELECTION = '#6366f1';

export interface PreviewStageProps {
  historyId: string;
  project: VideoProject;
  player: Player;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The item tool armed in the tool bar: dragging on the preview makes one. */
  tool: DrawTool | null;
  onToolDone: () => void;
  cropMode: boolean;
  /** width / height the crop keeps while it is resized, or null. */
  cropAspect: number | null;
  commit: (command: VideoCommand, gesture?: string) => void;
  endGesture: () => void;
  newId: () => string;
}

type Drag =
  | { kind: 'item'; id: string; handle: Handle; start: PixelRect; origin: { x: number; y: number } }
  | { kind: 'crop'; handle: Handle; start: PixelRect; origin: { x: number; y: number } }
  | { kind: 'create'; origin: { x: number; y: number }; rect: PixelRect | null; moved: boolean };

/** The tools that make an item by dragging a box on the preview. */
export type DrawTool = MaskKind | 'text';

const isActive = (item: Item, ms: number): boolean => item.startMs <= ms && ms < item.endMs;

/**
 * The preview: the recording in a <video> with a canvas on top that draws what the export will
 * draw (boxes, blur, pixelation, spotlight) for the items active at the current time, the crop as
 * a dimmed border, and the handles of what is selected. The canvas is only ever drawn to (never read),
 * so the video's own origin does not matter. Blur and pixelation are approximations of the export.
 */
export function PreviewStage(props: PreviewStageProps) {
  const { project, player } = props;
  const { width: sourceWidth, height: sourceHeight } = project.source;
  const [nonce] = useState(newNonce);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const dragRef = useRef<Drag | null>(null);
  const live = useRef(props);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  /** The pictures of image items, loaded once from the project's assets. */
  const images = useRef(new Map<string, HTMLImageElement>());
  /** Counts pictures and fonts that finished loading: the overlay is drawn again. */
  const [loaded, setLoaded] = useState(0);

  useLayoutEffect(() => {
    live.current = props;
  });

  // The displayed picture: the biggest box of the recording's shape that fits.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = (): void => {
      const available = {
        width: Math.max(0, container.clientWidth - STAGE_PADDING * 2),
        height: Math.max(0, container.clientHeight - STAGE_PADDING * 2),
      };
      const scale = Math.min(available.width / sourceWidth, available.height / sourceHeight);
      setBox({ width: Math.floor(sourceWidth * scale), height: Math.floor(sourceHeight * scale) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [sourceWidth, sourceHeight]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !video || !ctx) return;
    const { project: current, selectedId, cropMode } = live.current;
    const ms = player.getSnapshot().timeMs;
    const k = canvas.width / current.source.width;
    const ready = video.readyState >= 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const imageOf = (assetId: string): HTMLImageElement | null => {
      let image = images.current.get(assetId);
      if (!image) {
        image = new Image();
        image.onload = () => setLoaded((n) => n + 1);
        image.src = assetUrl(live.current.historyId, assetId, 'png');
        images.current.set(assetId, image);
      }
      return image.complete && image.naturalWidth > 0 ? image : null;
    };
    for (const item of current.items) {
      if (isVisual(item) && isActive(item, ms)) {
        drawItem(ctx, video, item, ms, k, ready, scratchCanvas(scratch), imageOf);
      }
    }
    const creating = dragRef.current?.kind === 'create' ? dragRef.current.rect : null;
    const tool = live.current.tool;
    if (creating && tool) {
      const preview =
        tool === 'text'
          ? newText('preview', creating, ms, ms + 1)
          : newItem(tool, 'preview', creating, ms, ms + 1);
      if (isVisual(preview)) {
        drawItem(ctx, video, preview, ms, k, ready, scratchCanvas(scratch), imageOf);
      }
      outline(ctx, creating, k, false);
    }
    if (current.crop) dimOutside(ctx, current.crop, k, canvas, cropMode ? 0.6 : 0.5);
    if (cropMode) {
      const crop = current.crop ?? fullFrame(current);
      outline(ctx, crop, k, true);
    } else {
      const selected = current.items.find((item) => item.id === selectedId);
      if (selected && isVisual(selected)) {
        outline(ctx, selected.rect, k, true, !isActive(selected, ms));
      }
    }
  }, [player]);

  // Text is drawn with fonts that load on first use: draw again once they are there.
  const fonts = project.items
    .filter((item): item is TextItem => item.kind === 'text')
    .map(fontOf)
    .join('|');
  useEffect(() => {
    let current = true;
    const texts = live.current.project.items.filter(
      (item): item is TextItem => item.kind === 'text',
    );
    void Promise.all(texts.map((item) => loadFontFor(item))).then(
      () => current && setLoaded((n) => n + 1),
    );
    return () => {
      current = false;
    };
  }, [fonts]);

  // Redraw when the picture changes (every presented frame), the time moves, or anything edited.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    player.attach(video);
    const stop = player.subscribe(draw);
    let handle = 0;
    const loop = (): void => {
      draw();
      handle = video.requestVideoFrameCallback(loop);
    };
    handle = video.requestVideoFrameCallback(loop);
    // A frame that arrives after a seek is drawn even if no frame callback is due.
    const events = ['seeked', 'loadeddata', 'canplay'] as const;
    for (const type of events) video.addEventListener(type, draw);
    return () => {
      stop();
      for (const type of events) video.removeEventListener(type, draw);
      video.cancelVideoFrameCallback(handle);
      player.detach();
    };
  }, [player, draw]);

  useEffect(draw, [draw, project, props.selectedId, props.cropMode, box, props.tool, loaded]);

  // What you hear follows the project's mute and volume (the browser cannot play louder than 100 %).
  useEffect(
    () => player.applyAudio(project.audio.volume, project.audio.muted),
    [player, project.audio.volume, project.audio.muted],
  );

  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const canvasWidth = Math.max(1, Math.round(box.width * dpr));
  const canvasHeight = Math.max(1, Math.round(box.height * dpr));

  const toSource = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * sourceWidth,
      y: ((event.clientY - rect.top) / rect.height) * sourceHeight,
    };
  };
  /** One screen pixel in source pixels (how far a handle reaches). */
  const reach = (): number => (box.width > 0 ? (sourceWidth / box.width) * 8 : 8);
  const bounds = { width: sourceWidth, height: sourceHeight };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return;
    const { project: current, selectedId, tool, cropMode, onSelect } = props;
    const point = toSource(event);
    const ms = player.getSnapshot().timeMs;
    let drag: Drag | null = null;
    if (cropMode) {
      const crop = current.crop ?? fullFrame(current);
      const handle = hitHandle(point, crop, reach());
      drag = handle
        ? { kind: 'crop', handle, start: crop, origin: point }
        : { kind: 'create', origin: point, rect: null, moved: false };
    } else if (tool) {
      drag = { kind: 'create', origin: point, rect: null, moved: false };
    } else {
      const selected = current.items.find((item) => item.id === selectedId);
      const handle =
        selected && isVisual(selected) ? hitHandle(point, selected.rect, reach()) : null;
      if (selected && isVisual(selected) && handle) {
        drag = { kind: 'item', id: selected.id, handle, start: selected.rect, origin: point };
      } else {
        // The topmost item under the pointer that is on screen right now.
        const hit = [...current.items]
          .reverse()
          .filter(isVisual)
          .find((item) => isActive(item, ms) && hitHandle(point, item.rect, 0) === 'move');
        onSelect(hit?.id ?? null);
        if (hit)
          drag = { kind: 'item', id: hit.id, handle: 'move', start: hit.rect, origin: point };
      }
    }
    if (!drag) return;
    dragRef.current = drag;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const point = toSource(event);
    const drag = dragRef.current;
    const canvas = event.currentTarget;
    if (!drag) {
      const { project: current, selectedId, tool, cropMode } = props;
      let hover: Handle | null = null;
      if (cropMode) hover = hitHandle(point, current.crop ?? fullFrame(current), reach());
      else if (!tool) {
        const selected = current.items.find((item) => item.id === selectedId);
        hover = selected && isVisual(selected) ? hitHandle(point, selected.rect, reach()) : null;
      }
      canvas.style.cursor = tool || (cropMode && hover === null) ? 'crosshair' : cursorFor(hover);
      return;
    }
    const dx = point.x - drag.origin.x;
    const dy = point.y - drag.origin.y;
    if (drag.kind === 'item') {
      const rect = dragRect(drag.start, drag.handle, dx, dy, bounds, MIN_BOX_PX);
      props.commit({ type: 'updateItem', id: drag.id, patch: { rect } }, `rect:${drag.id}`);
    } else if (drag.kind === 'crop') {
      const rect = dragRect(
        drag.start,
        drag.handle,
        dx,
        dy,
        bounds,
        MIN_CROP_PX,
        props.cropAspect ?? undefined,
      );
      props.commit({ type: 'setCrop', crop: rect }, 'crop');
    } else {
      drag.moved = drag.moved || Math.hypot(dx, dy) > reach() / 2;
      drag.rect = drag.moved
        ? rectFromPoints(drag.origin, point, bounds, props.cropMode ? MIN_CROP_PX : MIN_BOX_PX)
        : null;
      draw();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.kind !== 'create') {
      props.endGesture();
      return;
    }
    if (props.cropMode) {
      if (drag.rect) props.commit({ type: 'setCrop', crop: drag.rect });
      draw();
      return;
    }
    const tool = props.tool;
    if (!tool) return;
    const rect =
      drag.rect ??
      rectAround(
        toSource(event),
        {
          width: Math.round(sourceWidth * DEFAULT_BOX.width),
          height: Math.round(sourceHeight * DEFAULT_BOX.height),
        },
        bounds,
      );
    const { trim } = project;
    const now = player.getSnapshot().timeMs;
    const endMs = Math.min(trim.endMs, Math.max(trim.startMs, now) + DEFAULT_ITEM_MS);
    const startMs = Math.max(trim.startMs, Math.min(now, endMs - MIN_ITEM_MS));
    const id = props.newId();
    props.commit({
      type: 'addItem',
      item:
        tool === 'text'
          ? newText(id, rect, startMs, endMs)
          : newItem(tool, id, rect, startMs, endMs),
    });
    props.onSelect(id);
    props.onToolDone();
  };

  return (
    <div
      ref={containerRef}
      data-testid="video-stage"
      className="checkerboard relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
    >
      <div
        className="relative bg-black shadow-raised"
        style={{ width: box.width, height: box.height }}
      >
        <video
          ref={videoRef}
          data-testid="video-preview"
          src={fileUrl(props.historyId, nonce)}
          preload="auto"
          playsInline
          disablePictureInPicture
          onLoadedMetadata={(event) => revealDuration(event.currentTarget)}
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full"
        />
        <canvas
          ref={canvasRef}
          data-testid="video-overlay"
          width={canvasWidth}
          height={canvasHeight}
          className="absolute inset-0 size-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      {failed ? (
        <div
          role="alert"
          className="absolute inset-x-6 top-4 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-fg shadow-raised"
        >
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
          This recording could not be played. The file may have been moved or damaged.
        </div>
      ) : null}
    </div>
  );
}

// --- drawing ----------------------------------------------------------------------------------

const fullFrame = (project: VideoProject): PixelRect => ({
  x: 0,
  y: 0,
  width: project.source.width,
  height: project.source.height,
});

function scratchCanvas(ref: { current: HTMLCanvasElement | null }): HTMLCanvasElement {
  ref.current ??= document.createElement('canvas');
  return ref.current;
}

function drawItem(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  item: VisualItem,
  ms: number,
  k: number,
  ready: boolean,
  scratch: HTMLCanvasElement,
  imageOf: (assetId: string) => HTMLImageElement | null,
): void {
  const { x, y, width, height } = item.rect;
  const canvas = ctx.canvas;
  if (item.kind === 'text') {
    // The very code the export uses (see text-draw.ts), at the preview's scale.
    ctx.save();
    ctx.translate(x * k, y * k);
    ctx.scale(k, k);
    drawTextItem(ctx, item, fadeAlpha(item, ms));
    ctx.restore();
  } else if (item.kind === 'image') {
    const image = imageOf(item.assetId);
    if (image) {
      ctx.save();
      ctx.globalAlpha = item.opacity * fadeAlpha(item, ms);
      ctx.drawImage(image, x * k, y * k, width * k, height * k);
      ctx.restore();
    }
  } else if (item.kind === 'redact') {
    ctx.fillStyle = item.color;
    ctx.fillRect(x * k, y * k, width * k, height * k);
  } else if (item.kind === 'highlight') {
    ctx.fillStyle = `rgba(0,0,0,${item.dim})`;
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(x * k, y * k, width * k, height * k);
    ctx.fill('evenodd');
  } else if (item.kind === 'blur' && ready) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x * k, y * k, width * k, height * k);
    ctx.clip();
    ctx.filter = `blur(${Math.max(1, item.amount * 0.6 * k)}px)`;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  } else if (item.kind === 'pixelate' && ready) {
    const blocksX = Math.max(1, Math.ceil(width / item.block));
    const blocksY = Math.max(1, Math.ceil(height / item.block));
    scratch.width = blocksX;
    scratch.height = blocksY;
    const small = scratch.getContext('2d');
    if (!small) return;
    const scaleX = video.videoWidth / canvas.width;
    const scaleY = video.videoHeight / canvas.height;
    small.drawImage(
      video,
      x * k * scaleX,
      y * k * scaleY,
      width * k * scaleX,
      height * k * scaleY,
      0,
      0,
      blocksX,
      blocksY,
    );
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, blocksX, blocksY, x * k, y * k, width * k, height * k);
    ctx.restore();
  }
}

/** Dims everything outside `crop`: what the export will not contain. */
function dimOutside(
  ctx: CanvasRenderingContext2D,
  crop: PixelRect,
  k: number,
  canvas: HTMLCanvasElement,
  alpha: number,
): void {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(crop.x * k, crop.y * k, crop.width * k, crop.height * k);
  ctx.fill('evenodd');
}

/** A box outline, with the eight handles when `handles`; dashed when it is not on screen now. */
function outline(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  k: number,
  handles: boolean,
  dashed = false,
): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = SELECTION;
  ctx.setLineDash(dashed ? [6 * dpr, 4 * dpr] : []);
  ctx.strokeRect(rect.x * k, rect.y * k, rect.width * k, rect.height * k);
  ctx.setLineDash([]);
  if (handles) {
    const size = 8 * dpr;
    for (const handle of RESIZE_HANDLES) {
      const at = handlePosition(rect, handle);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(at.x * k - size / 2, at.y * k - size / 2, size, size);
      ctx.strokeRect(at.x * k - size / 2, at.y * k - size / 2, size, size);
    }
  }
  ctx.restore();
}
