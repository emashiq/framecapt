import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import {
  drawAnnotations,
  drawRedactions,
  renderDoc,
  type DrawContext,
  type DrawEnv,
  type EffectCache,
} from '../../editor/flatten';
import type { EditorAssets } from '../../editor/assets';
import { pictureIn } from '../../editor/import-image';
import { measureText } from '../../editor/measure';
import { snapMove, type Guide } from '../../editor/model/arrange';
import type { Command } from '../../editor/model/commands';
import {
  draftFor,
  isDraftBigEnough,
  penDraft,
  simplifyStroke,
  stampAt,
  stepAt,
  textDraft,
  type DragTool,
  type StyleDefaults,
} from '../../editor/model/create';
import {
  aspectFromAnchor,
  clampRectToImage,
  enforceAspect,
  intersectRects,
  rectFromPoints,
  translateRect,
} from '../../editor/model/geometry';
import {
  annotationBounds,
  handlesFor,
  hitHandle,
  hitTest,
  moveAnnotation,
  rectHandles,
  resizeAnnotation,
  resizeRect,
  type HandleId,
} from '../../editor/model/hit-test';
import {
  FONT_STACKS,
  TEXT_LINE_HEIGHT,
  beautifyActive,
  exportSize,
  textFont,
  type Annotation,
  type CalloutAnnotation,
  type EditorDoc,
  type Point,
  type Rect,
  type TextAnnotation,
} from '../../editor/model/types';
import {
  centerView,
  clampPan,
  clampZoom,
  cssScale,
  fitView,
  imageToScreen,
  screenToImage,
  stepZoom,
  zoomAt,
  type Size,
  type View,
} from '../../editor/view';
import type { ToolId } from './tools';

/** Operations the toolbar and the keyboard run on the stage. */
export interface StageHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  actualSize(): void;
  /** Cancels an in-progress draw, drag or text edit. Returns whether there was one. */
  cancel(): boolean;
  /** Commits an open text edit (used before saving or copying). */
  commitText(): void;
  /** Puts keyboard focus on the canvas (after a capture opens in the editor). */
  focus(): void;
}

export interface EditorStageProps {
  handleRef?: Ref<StageHandle>;
  bitmap: ImageBitmap;
  doc: EditorDoc;
  tool: ToolId;
  selectedIds: readonly string[];
  /** What new elements are made with. */
  defaults: StyleDefaults;
  cropDraft: Rect | null;
  /** The width:height ratio the crop keeps, or null for free. */
  cropAspect: number | null;
  onCropDraft: (rect: Rect | null) => void;
  /** Smart guides and snapping while moving. */
  snap: boolean;
  /** Shows the finished export (frame included) instead of the editing view. */
  previewExport: boolean;
  onCommit: (command: Command, gesture?: string) => void;
  onEndGesture: () => void;
  onSelect: (ids: string[]) => void;
  /** Called with the zoom factor (1 = 100%) whenever it changes. */
  onZoom: (zoom: number) => void;
  /** A step badge was placed: the counter moves on. */
  onStepPlaced: () => void;
  /** The pictures of the document's image layers. */
  assets: EditorAssets;
  /** A picture file was dropped on the canvas, at this point (image px). */
  onDropImage: (file: File, at: Point) => void;
}

/** The text being typed on the canvas: a new or existing text or callout. */
interface EditingText {
  id: string;
  isNew: boolean;
  /** The element as it was before the edit (a new one starts with empty text). */
  template: TextAnnotation | CalloutAnnotation;
  value: string;
}

type Drag =
  | { kind: 'pan'; startCss: Point; startView: View }
  | { kind: 'create'; tool: DragTool; start: Point; id: string }
  | { kind: 'pen'; id: string; points: Point[]; highlighter: boolean }
  | { kind: 'place'; tool: 'step' | 'stamp'; at: Point }
  | {
      kind: 'move';
      /** The mark under the pointer: a click that does not drag selects just it. */
      hitId: string;
      originals: Annotation[];
      start: Point;
      startCss: Point;
      gesture: string;
      moved: boolean;
      bounds: Rect;
      others: Rect[];
      frame: Rect;
    }
  | { kind: 'marquee'; start: Point; additive: boolean; base: string[] }
  | { kind: 'handle'; original: Annotation; handle: HandleId; gesture: string }
  | { kind: 'crop-new'; start: Point }
  | { kind: 'crop-move'; original: Rect; start: Point }
  | { kind: 'crop-handle'; original: Rect; handle: HandleId }
  | { kind: 'text-click'; at: Point; hit: TextAnnotation | CalloutAnnotation | null };

const ACCENT = '#6366f1';
const GUIDE_COLOR = '#ec4899';
const HANDLE_CSS = 9;
const HANDLE_REACH_CSS = 9;
const HIT_TOLERANCE_CSS = 6;
/** Smaller drags than this (CSS px) are clicks, not new shapes. */
const MIN_DRAG_CSS = 4;
/** How close (CSS px) a moved mark must come to a line to snap to it. */
const SNAP_CSS = 6;
/** A freehand stroke is thinned to this tolerance (CSS px). */
const STROKE_EPSILON_CSS = 0.8;

const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  from: 'crosshair',
  to: 'crosshair',
  ctrl: 'grab',
  tail: 'crosshair',
};

const DRAG_TOOLS: readonly ToolId[] = [
  'rect',
  'ellipse',
  'line',
  'arrow',
  'highlight',
  'blur',
  'redact',
  'spotlight',
  'magnifier',
  'ruler',
  'callout',
];

const round = (rect: Rect): Rect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

function clampPoint(point: Point, doc: EditorDoc): Point {
  return {
    x: Math.min(doc.width, Math.max(0, point.x)),
    y: Math.min(doc.height, Math.max(0, point.y)),
  };
}

const isTextual = (
  annotation: Annotation | null | undefined,
): annotation is TextAnnotation | CalloutAnnotation =>
  annotation?.type === 'text' || annotation?.type === 'callout';

/** Geometry only (never text), so the automated tests can check what the pointer produced. */
function geometryOf(annotation: Annotation | undefined): string {
  if (!annotation) return '';
  switch (annotation.type) {
    case 'arrow':
    case 'line':
    case 'ruler':
      return JSON.stringify({ from: annotation.from, to: annotation.to });
    case 'text':
      return JSON.stringify({ at: annotation.at, fontSize: annotation.fontSize });
    case 'step':
    case 'stamp':
      return JSON.stringify({ at: annotation.at, size: annotation.size });
    case 'pen':
      return JSON.stringify({ points: annotation.points.length });
    case 'callout':
      return JSON.stringify({ rect: annotation.rect, tail: annotation.tail });
    default:
      return JSON.stringify({ rect: annotation.rect });
  }
}

/**
 * The canvas: one visible <canvas> redrawn on demand (state changes and pointer drags, never in a
 * loop while idle), pointer interactions, zoom/pan and the inline text editor. Every pointer
 * position goes through `screenToImage`; the model only ever sees image pixels.
 */
export function EditorStage(props: EditorStageProps) {
  const { doc, tool, selectedIds, cropDraft, onZoom, handleRef, previewExport } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  // null = "fit to view": the view follows the stage size until the user zooms or pans.
  const [userView, setUserView] = useState<View | null>(null);
  const [editing, setEditingState] = useState<EditingText | null>(null);

  const image = useMemo<Size>(
    () => ({ width: doc.width, height: doc.height }),
    [doc.width, doc.height],
  );
  const view = useMemo(
    () => userView ?? fitView(stageSize, image, dpr),
    [userView, stageSize, image, dpr],
  );

  const dragRef = useRef<Drag | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  const marqueeRef = useRef<Rect | null>(null);
  const guidesRef = useRef<Guide[]>([]);
  const spaceRef = useRef(false);
  const editingRef = useRef<EditingText | null>(null);
  const rafRef = useRef(0);
  /** Blurred and pixelated regions, kept between redraws (cleared when the image changes). */
  const effectCache = useRef<EffectCache>(new Map());
  const latest = useRef({ ...props, view, dpr, stageSize, image, editing });

  const setEditing = useCallback((next: EditingText | null) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);

  useEffect(() => {
    effectCache.current.clear();
  }, [props.bitmap]);

  // --- drawing ---------------------------------------------------------------------------

  const draw = useCallback(() => {
    const L = latest.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { doc: d } = L;
    const ratio = L.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (L.previewExport) {
      // The finished export (frame included), fitted: exactly what Save writes.
      const out = exportSize(d);
      const fitted = fitView(L.stageSize, out, ratio);
      const px = fitted.panX * ratio;
      const py = fitted.panY * ratio;
      ctx.save();
      ctx.setTransform(fitted.zoom, 0, 0, fitted.zoom, px, py);
      ctx.imageSmoothingQuality = 'high';
      renderDoc(ctx as unknown as DrawContext, L.bitmap, d, {
        forExport: true,
        cache: effectCache.current,
        shadowScale: fitted.zoom,
        assets: L.assets,
      });
      ctx.restore();
      return;
    }

    const { view: v } = L;
    const scale = v.zoom;
    let ox = v.panX * ratio;
    let oy = v.panY * ratio;
    if (scale >= 1) {
      ox = Math.round(ox);
      oy = Math.round(oy);
    }

    // Drop shadow: a black rect with a shadow under the (opaque) image.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
    ctx.shadowBlur = 28 * ratio;
    ctx.shadowOffsetY = 8 * ratio;
    ctx.fillStyle = '#000';
    ctx.fillRect(ox, oy, d.width * scale, d.height * scale);
    ctx.restore();

    // Image space: base image, annotations and redactions, clipped to the image like the export.
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.beginPath();
    ctx.rect(0, 0, d.width, d.height);
    ctx.clip();
    renderDoc(ctx as unknown as DrawContext, L.bitmap, d, {
      forExport: false,
      skipId: L.editing?.id ?? null,
      cache: effectCache.current,
      shadowScale: scale,
      assets: L.assets,
    });
    const draft = draftRef.current;
    if (draft) {
      const env: DrawEnv = {
        base: L.bitmap,
        baseWidth: d.width,
        baseHeight: d.height,
        createCanvas: undefined,
        cache: effectCache.current,
        shadowScale: scale,
      };
      drawAnnotations(ctx as unknown as DrawContext, [draft], null, env);
      drawRedactions(ctx as unknown as DrawContext, [draft]);
    }
    const crop = L.tool === 'crop' ? L.cropDraft : d.crop;
    if (crop) {
      ctx.fillStyle = 'rgba(8, 10, 20, 0.58)';
      ctx.fillRect(0, 0, d.width, crop.y);
      ctx.fillRect(0, crop.y + crop.height, d.width, d.height - crop.y - crop.height);
      ctx.fillRect(0, crop.y, crop.x, crop.height);
      ctx.fillRect(crop.x + crop.width, crop.y, d.width - crop.x - crop.width, crop.height);
    }
    ctx.restore();

    // Device space: selection, handles and size labels stay crisp at any zoom.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toDevice = (p: Point): Point => ({ x: p.x * scale + ox, y: p.y * scale + oy });
    const strokeRectDevice = (rect: Rect, dash: boolean, color?: string): void => {
      const a = toDevice({ x: rect.x, y: rect.y });
      ctx.save();
      ctx.strokeStyle = color ?? (dash ? ACCENT : '#ffffff');
      ctx.lineWidth = 1.5 * ratio;
      if (dash) ctx.setLineDash([6 * ratio, 4 * ratio]);
      ctx.strokeRect(a.x, a.y, rect.width * scale, rect.height * scale);
      ctx.restore();
    };
    const drawHandle = (p: Point, round = false): void => {
      const size = HANDLE_CSS * ratio;
      const c = toDevice(p);
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5 * ratio;
      ctx.beginPath();
      if (round) ctx.arc(c.x, c.y, size / 2, 0, Math.PI * 2);
      else ctx.rect(c.x - size / 2, c.y - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };
    const drawLabel = (rect: Rect, text: string): void => {
      const a = toDevice({ x: rect.x + rect.width, y: rect.y + rect.height });
      ctx.save();
      ctx.font = `600 ${12 * ratio}px 'Inter Variable', system-ui, sans-serif`;
      const width = ctx.measureText(text).width + 14 * ratio;
      const height = 22 * ratio;
      const x = Math.min(canvas.width - width - 4 * ratio, Math.max(4 * ratio, a.x - width));
      const y = Math.min(canvas.height - height - 4 * ratio, a.y + 8 * ratio);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, 6 * ratio);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 7 * ratio, y + height / 2 + 0.5 * ratio);
      ctx.restore();
    };

    if (L.tool === 'crop' && L.cropDraft) {
      strokeRectDevice(L.cropDraft, false);
      for (const handle of rectHandles(L.cropDraft)) drawHandle(handle.point);
      drawLabel(L.cropDraft, `${L.cropDraft.width} × ${L.cropDraft.height}`);
    } else if (d.crop) {
      strokeRectDevice(d.crop, true);
    }

    const selected = d.annotations.filter((annotation) => L.selectedIds.includes(annotation.id));
    if (L.tool !== 'crop') {
      for (const annotation of selected) {
        if (annotation.id === L.editing?.id) continue;
        const lineLike =
          annotation.type === 'arrow' || annotation.type === 'line' || annotation.type === 'ruler';
        if (!lineLike || selected.length > 1) {
          strokeRectDevice(annotationBounds(annotation, measureText), true);
        }
      }
      const only = selected.length === 1 ? selected[0] : undefined;
      if (only && only.id !== L.editing?.id) {
        for (const handle of handlesFor(only, measureText)) {
          drawHandle(handle.point, handle.id === 'ctrl' || handle.id === 'tail');
        }
      }
    }
    // Smart guides while a mark is moved.
    if (guidesRef.current.length > 0) {
      ctx.save();
      ctx.strokeStyle = GUIDE_COLOR;
      ctx.lineWidth = ratio;
      ctx.setLineDash([4 * ratio, 3 * ratio]);
      for (const guide of guidesRef.current) {
        ctx.beginPath();
        if (guide.axis === 'x') {
          const a = toDevice({ x: guide.position, y: guide.from });
          const b = toDevice({ x: guide.position, y: guide.to });
          ctx.moveTo(Math.round(a.x) + 0.5, a.y);
          ctx.lineTo(Math.round(b.x) + 0.5, b.y);
        } else {
          const a = toDevice({ x: guide.from, y: guide.position });
          const b = toDevice({ x: guide.to, y: guide.position });
          ctx.moveTo(a.x, Math.round(a.y) + 0.5);
          ctx.lineTo(b.x, Math.round(b.y) + 0.5);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      const a = toDevice({ x: m.x, y: m.y });
      ctx.save();
      ctx.fillStyle = 'rgba(99, 102, 241, 0.12)';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = ratio;
      ctx.fillRect(a.x, a.y, m.width * scale, m.height * scale);
      ctx.strokeRect(a.x, a.y, m.width * scale, m.height * scale);
      ctx.restore();
    }
    if (draft && 'rect' in draft && draft.type !== 'callout') {
      drawLabel(draft.rect, `${Math.round(draft.rect.width)} × ${Math.round(draft.rect.height)}`);
    }
  }, []);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  // Every render draws synchronously (no flash when the canvas is resized); there is no loop.
  useLayoutEffect(() => {
    latest.current = { ...props, view, dpr, stageSize, image, editing };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    draw();
  });

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  useEffect(() => {
    onZoom(view.zoom);
  }, [view.zoom, onZoom]);

  // Text drawn before a font finished loading would use the fallback: redraw when it arrives.
  useEffect(() => {
    const fonts = document.fonts;
    fonts.addEventListener('loadingdone', requestDraw);
    return () => fonts.removeEventListener('loadingdone', requestDraw);
  }, [requestDraw]);

  // --- stage size, DPR ---------------------------------------------------------------------

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const sync = (): void => {
      const rect = container.getBoundingClientRect();
      setStageSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
      setDpr(window.devicePixelRatio || 1);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, []);

  // --- zoom and pan ------------------------------------------------------------------------

  const applyView = useCallback((next: View) => {
    const L = latest.current;
    setUserView(clampPan(next, L.stageSize, L.image, L.dpr));
  }, []);

  const zoomAround = useCallback(
    (zoom: number, anchor?: Point) => {
      const L = latest.current;
      const at = anchor ?? { x: L.stageSize.width / 2, y: L.stageSize.height / 2 };
      applyView(zoomAt(L.view, L.dpr, zoom, at));
    },
    [applyView],
  );

  const commitEdit = useCallback(() => {
    const current = editingRef.current;
    if (!current) return;
    setEditing(null);
    const { onCommit, onSelect, onEndGesture } = latest.current;
    const empty = current.value.trim() === '';
    if (current.isNew) {
      if (empty) return;
      onCommit({
        type: 'add',
        annotation: { ...current.template, text: current.value },
      });
      onSelect([current.id]);
    } else if (empty) {
      onCommit({ type: 'remove', id: current.id });
      onSelect([]);
    } else {
      onCommit({ type: 'update', id: current.id, patch: { text: current.value } });
    }
    onEndGesture();
  }, [setEditing]);

  useImperativeHandle(
    handleRef,
    () => ({
      zoomIn: () => zoomAround(stepZoom(latest.current.view.zoom, 1)),
      zoomOut: () => zoomAround(stepZoom(latest.current.view.zoom, -1)),
      fit: () => setUserView(null),
      actualSize: () => {
        const L = latest.current;
        setUserView(centerView(L.stageSize, L.image, 1, L.dpr));
      },
      cancel: () => {
        if (editingRef.current) {
          setEditing(null);
          return true;
        }
        if (dragRef.current || draftRef.current || marqueeRef.current) {
          dragRef.current = null;
          draftRef.current = null;
          marqueeRef.current = null;
          guidesRef.current = [];
          requestDraw();
          return true;
        }
        return false;
      },
      commitText: () => commitEdit(),
      focus: () => canvasRef.current?.focus({ preventScroll: true }),
    }),
    [zoomAround, requestDraw, setEditing, commitEdit],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const L = latest.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = container.getBoundingClientRect();
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        applyView(
          zoomAt(L.view, L.dpr, clampZoom(L.view.zoom * Math.pow(1.0015, -event.deltaY)), anchor),
        );
        return;
      }
      const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
      applyView({ ...L.view, panX: L.view.panX - dx, panY: L.view.panY - dy });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [applyView]);

  // Space + drag pans (like most editors). Typing a space in the text box is left alone.
  useEffect(() => {
    const typing = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && !!target.closest('input, textarea, select, [role="menu"]');
    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || typing(event.target)) return;
      if (event.target instanceof HTMLElement && event.target.closest('button')) return;
      event.preventDefault();
      spaceRef.current = true;
      if (canvasRef.current && !dragRef.current) canvasRef.current.style.cursor = 'grab';
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return;
      spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // --- text editing ------------------------------------------------------------------------

  const startEditing = useCallback(
    (next: EditingText) => {
      setEditing(next);
      const t = next.template;
      void document.fonts.load(
        textFont(
          t.fontSize,
          t.fontWeight,
          t.type === 'text' ? t.family : 'sans',
          t.type === 'text' ? t.italic : false,
        ),
        next.value || 'Aa',
      );
    },
    [setEditing],
  );

  // Focus the field as soon as it exists (pointer focus changes already happened on pointer down).
  useLayoutEffect(() => {
    const field = textRef.current;
    if (!editing || !field) return;
    field.focus();
    if (!editingRef.current?.isNew) field.select();
    // Once per edited annotation, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  // --- pointer interaction -----------------------------------------------------------------

  const cssPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const setCursor = (cursor: string): void => {
    if (canvasRef.current) canvasRef.current.style.cursor = cursor;
  };

  const selectedOf = (L: typeof latest.current): Annotation[] =>
    L.doc.annotations.filter((annotation) => L.selectedIds.includes(annotation.id));

  const hoverCursor = (point: Point): string => {
    const L = latest.current;
    if (spaceRef.current) return 'grab';
    const scale = cssScale(L.view, L.dpr);
    if (L.tool === 'crop') {
      if (L.cropDraft) {
        const h = hitHandle(rectHandles(L.cropDraft), point, HANDLE_REACH_CSS / scale);
        if (h) return HANDLE_CURSOR[h.id];
        const c = L.cropDraft;
        if (
          point.x >= c.x &&
          point.x <= c.x + c.width &&
          point.y >= c.y &&
          point.y <= c.y + c.height
        )
          return 'move';
      }
      return 'crosshair';
    }
    const chosen = selectedOf(L);
    const only = chosen.length === 1 ? chosen[0] : undefined;
    if (only) {
      const h = hitHandle(handlesFor(only, measureText), point, HANDLE_REACH_CSS / scale);
      if (h) return HANDLE_CURSOR[h.id];
    }
    if (L.tool === 'select') {
      return hitTest(L.doc, point, HIT_TOLERANCE_CSS / scale, measureText) ? 'move' : 'default';
    }
    return L.tool === 'text' ? 'text' : 'crosshair';
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const L = latest.current;
    if (L.previewExport) return;
    const css = cssPoint(event);
    if (event.button === 1 || (event.button === 0 && spaceRef.current)) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { kind: 'pan', startCss: css, startView: L.view };
      setCursor('grabbing');
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = screenToImage(L.view, L.dpr, css);
    const scale = cssScale(L.view, L.dpr);
    const gesture = crypto.randomUUID();

    if (L.tool === 'crop') {
      const draft = L.cropDraft;
      if (draft) {
        const h = hitHandle(rectHandles(draft), point, HANDLE_REACH_CSS / scale);
        if (h) {
          dragRef.current = { kind: 'crop-handle', original: draft, handle: h.id };
          return;
        }
        const inside =
          point.x >= draft.x &&
          point.x <= draft.x + draft.width &&
          point.y >= draft.y &&
          point.y <= draft.y + draft.height;
        if (inside) {
          dragRef.current = { kind: 'crop-move', original: draft, start: point };
          return;
        }
      }
      dragRef.current = { kind: 'crop-new', start: clampPoint(point, L.doc) };
      return;
    }

    const chosen = selectedOf(L);
    const only = chosen.length === 1 ? chosen[0] : undefined;
    if (only) {
      const h = hitHandle(handlesFor(only, measureText), point, HANDLE_REACH_CSS / scale);
      if (h) {
        dragRef.current = { kind: 'handle', original: only, handle: h.id, gesture };
        return;
      }
    }

    const hit = hitTest(L.doc, point, HIT_TOLERANCE_CSS / scale, measureText);
    if (L.tool === 'select') {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (!hit) {
        dragRef.current = {
          kind: 'marquee',
          start: point,
          additive,
          base: additive ? [...L.selectedIds] : [],
        };
        if (!additive) L.onSelect([]);
        return;
      }
      if (additive) {
        // Shift-click toggles the mark in or out of the selection.
        L.onSelect(
          L.selectedIds.includes(hit.id)
            ? L.selectedIds.filter((id) => id !== hit.id)
            : [...L.selectedIds, hit.id],
        );
        return;
      }
      const keep = L.selectedIds.includes(hit.id) ? selectedOf(L) : [hit];
      if (!L.selectedIds.includes(hit.id)) L.onSelect([hit.id]);
      const ids = new Set(keep.map((annotation) => annotation.id));
      const frame = L.doc.crop ?? { x: 0, y: 0, width: L.doc.width, height: L.doc.height };
      dragRef.current = {
        kind: 'move',
        hitId: hit.id,
        originals: keep,
        start: point,
        startCss: css,
        gesture,
        moved: false,
        bounds: unionOf(keep.map((annotation) => annotationBounds(annotation, measureText))),
        others: L.doc.annotations
          .filter((annotation) => !ids.has(annotation.id))
          .map((annotation) => annotationBounds(annotation, measureText)),
        frame,
      };
      return;
    }
    if (L.tool === 'text') {
      dragRef.current = {
        kind: 'text-click',
        at: point,
        hit: isTextual(hit) && hit.type === 'text' ? hit : null,
      };
      return;
    }
    L.onSelect([]);
    if (L.tool === 'pen' || (L.tool === 'highlight' && L.defaults.highlightMode === 'freehand')) {
      dragRef.current = {
        kind: 'pen',
        id: crypto.randomUUID(),
        points: [clampPoint(point, L.doc)],
        highlighter: L.tool === 'highlight',
      };
      return;
    }
    if (L.tool === 'step' || L.tool === 'stamp') {
      dragRef.current = { kind: 'place', tool: L.tool, at: point };
      return;
    }
    if ((DRAG_TOOLS as readonly string[]).includes(L.tool)) {
      dragRef.current = {
        kind: 'create',
        tool: L.tool as DragTool,
        start: point,
        id: crypto.randomUUID(),
      };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const L = latest.current;
    if (L.previewExport) return;
    const css = cssPoint(event);
    const drag = dragRef.current;
    if (!drag) {
      setCursor(hoverCursor(screenToImage(L.view, L.dpr, css)));
      return;
    }
    const point = screenToImage(L.view, L.dpr, css);
    const scale = cssScale(L.view, L.dpr);
    switch (drag.kind) {
      case 'pan':
        applyView({
          zoom: drag.startView.zoom,
          panX: drag.startView.panX + (css.x - drag.startCss.x),
          panY: drag.startView.panY + (css.y - drag.startCss.y),
        });
        break;
      case 'create': {
        draftRef.current = draftFor(
          drag.tool,
          drag.id,
          drag.start,
          point,
          event.shiftKey,
          L.defaults,
        );
        requestDraw();
        break;
      }
      case 'pen': {
        const last = drag.points[drag.points.length - 1] as Point;
        const next = clampPoint(point, L.doc);
        if (Math.hypot(next.x - last.x, next.y - last.y) * scale >= 1.5) drag.points.push(next);
        draftRef.current = penDraft(drag.id, drag.points, L.defaults, drag.highlighter);
        requestDraw();
        break;
      }
      case 'place':
        break; // decided on release
      case 'move': {
        const dxCss = css.x - drag.startCss.x;
        const dyCss = css.y - drag.startCss.y;
        if (!drag.moved && Math.hypot(dxCss, dyCss) < 3) break;
        drag.moved = true;
        let dx = point.x - drag.start.x;
        let dy = point.y - drag.start.y;
        guidesRef.current = [];
        if (L.snap && !event.altKey) {
          const snapped = snapMove(
            translateRect(drag.bounds, dx, dy),
            drag.others,
            drag.frame,
            SNAP_CSS / scale,
          );
          dx += snapped.dx;
          dy += snapped.dy;
          guidesRef.current = snapped.guides;
        }
        const commands: Command[] = drag.originals.map((original) => ({
          type: 'update',
          id: original.id,
          patch: moveAnnotation(original, dx, dy),
        }));
        L.onCommit(
          commands.length === 1 ? (commands[0] as Command) : { type: 'batch', commands },
          drag.gesture,
        );
        requestDraw();
        break;
      }
      case 'marquee': {
        const rect = rectFromPoints(drag.start, point);
        marqueeRef.current = rect;
        const inside = L.doc.annotations
          .filter((annotation) => intersectRects(annotationBounds(annotation, measureText), rect))
          .map((annotation) => annotation.id);
        L.onSelect([...new Set([...drag.base, ...inside])]);
        requestDraw();
        break;
      }
      case 'handle': {
        // A curved arrow's bend, a bubble's tail and the ends of lines follow the pointer freely.
        L.onCommit(
          {
            type: 'update',
            id: drag.original.id,
            patch: resizeAnnotation(drag.original, drag.handle, point, event.shiftKey, measureText),
          },
          drag.gesture,
        );
        break;
      }
      case 'crop-new': {
        const end = clampPoint(point, L.doc);
        const rect =
          L.cropAspect !== null
            ? clampToImage(
                aspectFromAnchor(drag.start, end, L.cropAspect),
                L.doc,
                drag.start,
                L.cropAspect,
              )
            : rectFromPoints(drag.start, end);
        L.onCropDraft(round(rect));
        break;
      }
      case 'crop-move': {
        const dx = point.x - drag.start.x;
        const dy = point.y - drag.start.y;
        const moved = translateRect(drag.original, dx, dy);
        moved.x = Math.min(L.doc.width - moved.width, Math.max(0, moved.x));
        moved.y = Math.min(L.doc.height - moved.height, Math.max(0, moved.y));
        L.onCropDraft(round(moved));
        break;
      }
      case 'crop-handle': {
        let rect = resizeRect(drag.original, drag.handle, clampPoint(point, L.doc), event.shiftKey);
        if (L.cropAspect !== null) {
          rect = enforceAspect(rect, drag.original, drag.handle, L.cropAspect, {
            x: 0,
            y: 0,
            width: L.doc.width,
            height: L.doc.height,
          });
        }
        const clamped = clampRectToImage(rect, L.doc, 1);
        if (clamped) L.onCropDraft(clamped);
        break;
      }
      case 'text-click':
        break; // a text click is decided on release
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean): void => {
    const L = latest.current;
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag) return;
    const scale = cssScale(L.view, L.dpr);
    const draft = draftRef.current;
    draftRef.current = null;
    guidesRef.current = [];
    marqueeRef.current = null;
    if (drag.kind === 'pan') {
      setCursor(
        spaceRef.current ? 'grab' : hoverCursor(screenToImage(L.view, L.dpr, cssPoint(event))),
      );
      return;
    }
    if (drag.kind === 'move' && !drag.moved && !cancelled && drag.originals.length > 1) {
      L.onSelect([drag.hitId]);
    }
    if (drag.kind === 'create' && draft && !cancelled) {
      if (isDraftBigEnough(draft, scale, MIN_DRAG_CSS)) {
        if (draft.type === 'callout') {
          startEditing({ id: draft.id, isNew: true, template: draft, value: '' });
        } else {
          L.onCommit({ type: 'add', annotation: draft });
          L.onSelect([draft.id]);
        }
      }
    }
    if (drag.kind === 'pen' && draft?.type === 'pen' && !cancelled) {
      const thinned = simplifyStroke(drag.points, STROKE_EPSILON_CSS / scale);
      const stroke = {
        ...draft,
        points:
          thinned.length === 1
            ? [...thinned, { ...(thinned[0] as Point), x: (thinned[0] as Point).x + 0.01 }]
            : thinned,
      };
      L.onCommit({ type: 'add', annotation: stroke });
      L.onSelect([draft.id]);
    }
    if (drag.kind === 'place' && !cancelled) {
      const id = crypto.randomUUID();
      const at = clampPoint(drag.at, L.doc);
      L.onCommit({
        type: 'add',
        annotation:
          drag.tool === 'step'
            ? stepAt(id, at, L.defaults)
            : stampAt(id, at, L.defaults.stamp, L.defaults),
      });
      L.onSelect([id]);
      if (drag.tool === 'step') L.onStepPlaced();
    }
    if (drag.kind === 'text-click' && !cancelled) {
      const hit = drag.hit;
      if (hit) {
        L.onSelect([hit.id]);
        startEditing({ id: hit.id, isNew: false, template: hit, value: hit.text });
      } else {
        L.onSelect([]);
        const created = textDraft(crypto.randomUUID(), drag.at, L.defaults) as TextAnnotation;
        startEditing({ id: created.id, isNew: true, template: created, value: '' });
      }
    }
    L.onEndGesture();
    requestDraw();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const L = latest.current;
    if (L.tool !== 'select' || L.previewExport) return;
    const point = screenToImage(L.view, L.dpr, cssPoint(event));
    const hit = hitTest(L.doc, point, HIT_TOLERANCE_CSS / cssScale(L.view, L.dpr), measureText);
    if (!isTextual(hit)) return;
    L.onSelect([hit.id]);
    startEditing({ id: hit.id, isNew: false, template: hit, value: hit.text });
  };

  // --- render ------------------------------------------------------------------------------

  const scale = cssScale(view, dpr);
  const template = editing?.template;
  const editorPosition =
    editing && template
      ? imageToScreen(
          view,
          dpr,
          template.type === 'text' ? template.at : { x: template.rect.x, y: template.rect.y },
        )
      : null;
  const selectedAnnotations = doc.annotations.filter((annotation) =>
    selectedIds.includes(annotation.id),
  );
  const single = selectedAnnotations.length === 1 ? selectedAnnotations[0] : undefined;
  const selectedType = selectedAnnotations.length > 1 ? 'multiple' : (single?.type ?? '');
  const redactions = JSON.stringify(
    doc.annotations.flatMap((annotation) =>
      annotation.type === 'redact' ? [annotation.rect] : [],
    ),
  );
  const out = exportSize(doc);

  return (
    <div
      ref={containerRef}
      className="checkerboard relative min-h-0 flex-1 overflow-hidden"
      data-testid="editor-stage"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        const file = pictureIn(event.dataTransfer.files);
        if (!file) return;
        event.preventDefault();
        const L = latest.current;
        props.onDropImage(file, screenToImage(L.view, L.dpr, cssPoint(event)));
      }}
    >
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.round(stageSize.width * dpr))}
        height={Math.max(1, Math.round(stageSize.height * dpr))}
        style={{ width: stageSize.width, height: stageSize.height, touchAction: 'none' }}
        className="absolute inset-0 block focus-visible:outline-offset-[-3px]"
        data-testid="editor-canvas"
        data-zoom={view.zoom.toFixed(4)}
        data-pan-x={view.panX.toFixed(2)}
        data-pan-y={view.panY.toFixed(2)}
        data-dpr={dpr}
        data-tool={tool}
        data-annotations={doc.annotations.length}
        data-selected={selectedType}
        data-selected-count={selectedAnnotations.length}
        data-selected-geometry={geometryOf(single)}
        data-redactions={redactions}
        data-crop={doc.crop ? JSON.stringify(doc.crop) : ''}
        data-crop-draft={cropDraft ? JSON.stringify(cropDraft) : ''}
        data-export-size={`${out.width}x${out.height}`}
        data-framed={beautifyActive(doc) ? 'true' : 'false'}
        data-preview={previewExport ? 'true' : 'false'}
        role="img"
        tabIndex={0}
        aria-label={`Screenshot editor canvas, ${doc.width} by ${doc.height} pixels`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
        onDoubleClick={onDoubleClick}
      />
      {editing && template && editorPosition && (
        <textarea
          ref={textRef}
          value={editing.value}
          rows={1}
          spellCheck={false}
          aria-label={template.type === 'callout' ? 'Callout text' : 'Annotation text'}
          data-testid="editor-text-input"
          onChange={(event) => {
            const value = event.target.value;
            setEditing({ ...editing, value });
          }}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              commitEdit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(null);
              latest.current.onEndGesture();
            }
          }}
          style={{
            position: 'absolute',
            left: editorPosition.x,
            top: editorPosition.y,
            fontSize: template.fontSize * scale,
            lineHeight: TEXT_LINE_HEIGHT,
            fontFamily:
              FONT_STACKS[template.type === 'text' ? (template.family ?? 'sans') : 'sans'],
            fontWeight: template.fontWeight,
            fontStyle: template.type === 'text' && template.italic ? 'italic' : 'normal',
            textAlign: template.type === 'callout' ? 'center' : (template.align ?? 'left'),
            color: template.type === 'callout' ? template.textColor : template.color,
            minWidth: template.type === 'callout' ? template.rect.width * scale : '2ch',
            ...(template.type === 'callout' && {
              width: template.rect.width * scale,
              minHeight: template.rect.height * scale,
              background: template.color,
            }),
          }}
          className={
            template.type === 'callout'
              ? 'm-0 resize-none overflow-hidden rounded-[10px] border-0 p-1 whitespace-pre outline-1 outline-offset-2 outline-accent outline-dashed'
              : 'm-0 resize-none overflow-hidden border-0 bg-black/25 p-0 whitespace-pre outline-1 outline-offset-2 outline-accent [field-sizing:content] outline-dashed'
          }
        />
      )}
    </div>
  );
}

function unionOf(rects: Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Keeps an aspect-constrained crop inside the image by shrinking it toward its anchor. */
function clampToImage(
  rect: Rect,
  image: { width: number; height: number },
  anchor: Point,
  ratio: number,
): Rect {
  const roomX = rect.x < anchor.x ? anchor.x : image.width - anchor.x;
  const roomY = rect.y < anchor.y ? anchor.y : image.height - anchor.y;
  const width = Math.min(rect.width, roomX, roomY * ratio);
  const height = width / ratio;
  return rectFromPoints(anchor, {
    x: anchor.x + (rect.x < anchor.x ? -width : width),
    y: anchor.y + (rect.y < anchor.y ? -height : height),
  });
}
