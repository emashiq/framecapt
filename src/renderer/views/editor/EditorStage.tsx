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
import { drawAnnotations, drawRedactions, renderDoc, type DrawContext } from '../../editor/flatten';
import type { Command } from '../../editor/model/commands';
import {
  clampRectToImage,
  constrainTo45,
  rectFromPoints,
  squareFromAnchor,
  translateRect,
} from '../../editor/model/geometry';
import {
  handlesFor,
  hitHandle,
  hitTest,
  moveAnnotation,
  rectHandles,
  resizeAnnotation,
  resizeRect,
  textBounds,
  type HandleId,
  type TextMeasure,
} from '../../editor/model/hit-test';
import {
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  textFont,
  type Annotation,
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
}

/** What new annotations are made with. */
export interface StageDefaults {
  color: string;
  strokeWidth: number;
  fontSize: number;
  fontWeight: number;
}

export interface EditorStageProps {
  handleRef?: Ref<StageHandle>;
  bitmap: ImageBitmap;
  doc: EditorDoc;
  tool: ToolId;
  selectedId: string | null;
  defaults: StageDefaults;
  cropDraft: Rect | null;
  onCropDraft: (rect: Rect | null) => void;
  onCommit: (command: Command, gesture?: string) => void;
  onEndGesture: () => void;
  onSelect: (id: string | null) => void;
  /** Called with the zoom factor (1 = 100%) whenever it changes. */
  onZoom: (zoom: number) => void;
}

interface EditingText {
  id: string;
  isNew: boolean;
  at: Point;
  value: string;
  color: string;
  fontSize: number;
  fontWeight: number;
}

type Drag =
  | { kind: 'pan'; startCss: Point; startView: View }
  | { kind: 'create'; tool: 'arrow' | 'rect' | 'redact'; start: Point; id: string }
  | {
      kind: 'move';
      original: Annotation;
      start: Point;
      startCss: Point;
      gesture: string;
      moved: boolean;
    }
  | { kind: 'handle'; original: Annotation; handle: HandleId; gesture: string }
  | { kind: 'crop-new'; start: Point }
  | { kind: 'crop-move'; original: Rect; start: Point }
  | { kind: 'crop-handle'; original: Rect; handle: HandleId }
  | { kind: 'text-click'; at: Point; hit: TextAnnotation | null };

const ACCENT = '#6366f1';
const HANDLE_CSS = 9;
const HANDLE_REACH_CSS = 9;
const HIT_TOLERANCE_CSS = 6;
/** Smaller drags than this (CSS px) are clicks, not new shapes. */
const MIN_DRAG_CSS = 4;

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
};

let scratch: CanvasRenderingContext2D | null | undefined;

/** Measures text with the real canvas font engine, so hit boxes and handles match the pixels. */
const measureText: TextMeasure = (text, fontSize, fontWeight) => {
  scratch ??= document.createElement('canvas').getContext('2d');
  if (!scratch) return text.length * fontSize * 0.56;
  scratch.font = textFont(fontSize, fontWeight);
  return scratch.measureText(text).width;
};

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

/**
 * The canvas: one visible <canvas> redrawn on demand (state changes and pointer drags, never in a
 * loop while idle), pointer interactions, zoom/pan and the inline text editor. Every pointer
 * position goes through `screenToImage`; the model only ever sees image pixels.
 */
export function EditorStage(props: EditorStageProps) {
  const { doc, tool, selectedId, cropDraft, onZoom, handleRef } = props;
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
  const spaceRef = useRef(false);
  const editingRef = useRef<EditingText | null>(null);
  const rafRef = useRef(0);
  const latest = useRef({ ...props, view, dpr, stageSize, image, editing });

  const setEditing = useCallback((next: EditingText | null) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);

  // --- drawing ---------------------------------------------------------------------------

  const draw = useCallback(() => {
    const L = latest.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { view: v, dpr: ratio, doc: d } = L;
    const scale = v.zoom;
    let ox = v.panX * ratio;
    let oy = v.panY * ratio;
    if (scale >= 1) {
      ox = Math.round(ox);
      oy = Math.round(oy);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
    });
    const draft = draftRef.current;
    if (draft) {
      drawAnnotations(ctx as unknown as DrawContext, [draft]);
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
    const strokeRectDevice = (rect: Rect, dash: boolean): void => {
      const a = toDevice({ x: rect.x, y: rect.y });
      ctx.save();
      ctx.strokeStyle = dash ? ACCENT : '#ffffff';
      ctx.lineWidth = 1.5 * ratio;
      if (dash) ctx.setLineDash([6 * ratio, 4 * ratio]);
      ctx.strokeRect(a.x, a.y, rect.width * scale, rect.height * scale);
      ctx.restore();
    };
    const drawHandle = (p: Point): void => {
      const size = HANDLE_CSS * ratio;
      const c = toDevice(p);
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5 * ratio;
      ctx.beginPath();
      ctx.rect(c.x - size / 2, c.y - size / 2, size, size);
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

    const selected = d.annotations.find((annotation) => annotation.id === L.selectedId);
    if (selected && selected.id !== L.editing?.id && L.tool !== 'crop') {
      if (selected.type === 'rect' || selected.type === 'redact') {
        strokeRectDevice(selected.rect, true);
      } else if (selected.type === 'text') {
        strokeRectDevice(textBounds(selected, measureText), true);
      }
      for (const handle of handlesFor(selected, measureText)) drawHandle(handle.point);
    }
    if (draft && (draft.type === 'rect' || draft.type === 'redact')) {
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

  // Text drawn before Inter finished loading would use the fallback font: redraw when it arrives.
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
        annotation: {
          type: 'text',
          id: current.id,
          at: current.at,
          text: current.value,
          color: current.color,
          fontSize: current.fontSize,
          fontWeight: current.fontWeight,
        },
      });
      onSelect(current.id);
    } else if (empty) {
      onCommit({ type: 'remove', id: current.id });
      onSelect(null);
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
        if (dragRef.current || draftRef.current) {
          dragRef.current = null;
          draftRef.current = null;
          requestDraw();
          return true;
        }
        return false;
      },
      commitText: () => commitEdit(),
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
      void document.fonts.load(textFont(next.fontSize, next.fontWeight), next.value || 'Aa');
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
    const selected = L.doc.annotations.find((annotation) => annotation.id === L.selectedId);
    if (selected) {
      const h = hitHandle(handlesFor(selected, measureText), point, HANDLE_REACH_CSS / scale);
      if (h) return HANDLE_CURSOR[h.id];
    }
    if (L.tool === 'select') {
      return hitTest(L.doc, point, HIT_TOLERANCE_CSS / scale, measureText) ? 'move' : 'default';
    }
    return L.tool === 'text' ? 'text' : 'crosshair';
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const L = latest.current;
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

    const selected = L.doc.annotations.find((annotation) => annotation.id === L.selectedId);
    if (selected) {
      const h = hitHandle(handlesFor(selected, measureText), point, HANDLE_REACH_CSS / scale);
      if (h) {
        dragRef.current = { kind: 'handle', original: selected, handle: h.id, gesture };
        return;
      }
    }

    const hit = hitTest(L.doc, point, HIT_TOLERANCE_CSS / scale, measureText);
    if (L.tool === 'select') {
      L.onSelect(hit?.id ?? null);
      if (hit) {
        dragRef.current = {
          kind: 'move',
          original: hit,
          start: point,
          startCss: css,
          gesture,
          moved: false,
        };
      }
      return;
    }
    if (L.tool === 'text') {
      dragRef.current = { kind: 'text-click', at: point, hit: hit?.type === 'text' ? hit : null };
      return;
    }
    L.onSelect(null);
    dragRef.current = { kind: 'create', tool: L.tool, start: point, id: crypto.randomUUID() };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const L = latest.current;
    const css = cssPoint(event);
    const drag = dragRef.current;
    if (!drag) {
      setCursor(hoverCursor(screenToImage(L.view, L.dpr, css)));
      return;
    }
    const point = screenToImage(L.view, L.dpr, css);
    switch (drag.kind) {
      case 'pan':
        applyView({
          zoom: drag.startView.zoom,
          panX: drag.startView.panX + (css.x - drag.startCss.x),
          panY: drag.startView.panY + (css.y - drag.startCss.y),
        });
        break;
      case 'create': {
        if (drag.tool === 'arrow') {
          draftRef.current = {
            type: 'arrow',
            id: drag.id,
            from: drag.start,
            to: event.shiftKey ? constrainTo45(drag.start, point) : point,
            color: L.defaults.color,
            width: L.defaults.strokeWidth,
          };
        } else {
          const rect = event.shiftKey
            ? squareFromAnchor(drag.start, point)
            : rectFromPoints(drag.start, point);
          draftRef.current =
            drag.tool === 'redact'
              ? { type: 'redact', id: drag.id, rect }
              : {
                  type: 'rect',
                  id: drag.id,
                  rect,
                  color: L.defaults.color,
                  width: L.defaults.strokeWidth,
                };
        }
        requestDraw();
        break;
      }
      case 'move': {
        const dxCss = css.x - drag.startCss.x;
        const dyCss = css.y - drag.startCss.y;
        if (!drag.moved && Math.hypot(dxCss, dyCss) < 3) break;
        drag.moved = true;
        L.onCommit(
          {
            type: 'update',
            id: drag.original.id,
            patch: moveAnnotation(drag.original, point.x - drag.start.x, point.y - drag.start.y),
          },
          drag.gesture,
        );
        break;
      }
      case 'handle':
        L.onCommit(
          {
            type: 'update',
            id: drag.original.id,
            patch: resizeAnnotation(drag.original, drag.handle, point, event.shiftKey, measureText),
          },
          drag.gesture,
        );
        break;
      case 'crop-new': {
        const rect = rectFromPoints(drag.start, clampPoint(point, L.doc));
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
        const rect = resizeRect(
          drag.original,
          drag.handle,
          clampPoint(point, L.doc),
          event.shiftKey,
        );
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
    if (drag.kind === 'pan') {
      setCursor(
        spaceRef.current ? 'grab' : hoverCursor(screenToImage(L.view, L.dpr, cssPoint(event))),
      );
      return;
    }
    if (drag.kind === 'create' && draft && !cancelled) {
      const size =
        draft.type === 'arrow'
          ? Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y)
          : draft.type === 'text'
            ? 0
            : Math.max(draft.rect.width, draft.rect.height);
      const minSize =
        draft.type !== 'arrow' && draft.type !== 'text'
          ? Math.min(draft.rect.width, draft.rect.height)
          : size;
      if (size * scale >= MIN_DRAG_CSS && minSize * scale >= MIN_DRAG_CSS / 2) {
        L.onCommit({ type: 'add', annotation: draft });
        L.onSelect(draft.id);
      }
    }
    if (drag.kind === 'text-click' && !cancelled) {
      const hit = drag.hit;
      if (hit) {
        L.onSelect(hit.id);
        startEditing({
          id: hit.id,
          isNew: false,
          at: hit.at,
          value: hit.text,
          color: hit.color,
          fontSize: hit.fontSize,
          fontWeight: hit.fontWeight,
        });
      } else {
        L.onSelect(null);
        startEditing({
          id: crypto.randomUUID(),
          isNew: true,
          at: drag.at,
          value: '',
          color: L.defaults.color,
          fontSize: L.defaults.fontSize,
          fontWeight: L.defaults.fontWeight,
        });
      }
    }
    L.onEndGesture();
    requestDraw();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const L = latest.current;
    if (L.tool !== 'select') return;
    const point = screenToImage(L.view, L.dpr, cssPoint(event));
    const hit = hitTest(L.doc, point, HIT_TOLERANCE_CSS / cssScale(L.view, L.dpr), measureText);
    if (hit?.type !== 'text') return;
    L.onSelect(hit.id);
    startEditing({
      id: hit.id,
      isNew: false,
      at: hit.at,
      value: hit.text,
      color: hit.color,
      fontSize: hit.fontSize,
      fontWeight: hit.fontWeight,
    });
  };

  // --- render ------------------------------------------------------------------------------

  const scale = cssScale(view, dpr);
  const editorPosition = editing ? imageToScreen(view, dpr, editing.at) : null;
  const selectedAnnotation = doc.annotations.find((annotation) => annotation.id === selectedId);
  const selectedType = selectedAnnotation?.type ?? '';
  // Geometry only (never text), so the automated tests can check what the pointer produced.
  const geometry = (annotation: Annotation | undefined): string => {
    if (!annotation) return '';
    if (annotation.type === 'arrow')
      return JSON.stringify({ from: annotation.from, to: annotation.to });
    if (annotation.type === 'text')
      return JSON.stringify({ at: annotation.at, fontSize: annotation.fontSize });
    return JSON.stringify({ rect: annotation.rect });
  };
  const redactions = JSON.stringify(
    doc.annotations.flatMap((annotation) =>
      annotation.type === 'redact' ? [annotation.rect] : [],
    ),
  );

  return (
    <div
      ref={containerRef}
      className="checkerboard relative min-h-0 flex-1 overflow-hidden"
      data-testid="editor-stage"
    >
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.round(stageSize.width * dpr))}
        height={Math.max(1, Math.round(stageSize.height * dpr))}
        style={{ width: stageSize.width, height: stageSize.height, touchAction: 'none' }}
        className="absolute inset-0 block"
        data-testid="editor-canvas"
        data-zoom={view.zoom.toFixed(4)}
        data-pan-x={view.panX.toFixed(2)}
        data-pan-y={view.panY.toFixed(2)}
        data-dpr={dpr}
        data-tool={tool}
        data-annotations={doc.annotations.length}
        data-selected={selectedType}
        data-selected-geometry={geometry(selectedAnnotation)}
        data-redactions={redactions}
        data-crop={doc.crop ? JSON.stringify(doc.crop) : ''}
        data-crop-draft={cropDraft ? JSON.stringify(cropDraft) : ''}
        role="img"
        aria-label={`Screenshot editor canvas, ${doc.width} by ${doc.height} pixels`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
        onDoubleClick={onDoubleClick}
      />
      {editing && editorPosition && (
        <textarea
          ref={textRef}
          value={editing.value}
          rows={1}
          spellCheck={false}
          aria-label="Annotation text"
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
            fontSize: editing.fontSize * scale,
            lineHeight: TEXT_LINE_HEIGHT,
            fontFamily: TEXT_FONT_FAMILY,
            fontWeight: editing.fontWeight,
            color: editing.color,
            minWidth: '2ch',
          }}
          className="m-0 resize-none overflow-hidden border-0 bg-black/25 p-0 whitespace-pre outline-1 outline-offset-2 outline-accent [field-sizing:content] outline-dashed"
        />
      )}
    </div>
  );
}
