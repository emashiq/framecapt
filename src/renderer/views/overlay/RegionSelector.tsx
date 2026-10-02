import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Kbd } from '../../components/ui/Kbd';
import { cn } from '../../lib/cn';
import { bgraToRgba } from '../../../shared/pixels';
import { overlayRectToFramePixels, normalizeDragRect, type Point } from '../../../shared/geometry';
import type { Rect } from '../../../shared/rect';
import {
  clampPoint,
  defaultSelection,
  growRect,
  HANDLE_IDS,
  nudgeRect,
  placeActionBar,
  pointInRect,
  resizeRect,
  type HandleId,
} from '../../../shared/selection';
import type { OverlayInit } from '../../../shared/shot-ipc';
import { OverlayChip } from './OverlayChip';

const BAR_SIZE = { width: 268, height: 52 };
const DIM = 'rgb(0 0 0 / 0.45)';

type Interaction =
  | { kind: 'none' }
  | { kind: 'drawing'; origin: Point }
  | { kind: 'resizing'; handle: HandleId; start: Rect }
  | { kind: 'moving'; origin: Point; start: Rect };

const HANDLE_STYLE: Record<HandleId, { left: string; top: string; cursor: string }> = {
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' },
  n: { left: '50%', top: '0%', cursor: 'ns-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' },
  e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' },
  w: { left: '0%', top: '50%', cursor: 'ew-resize' },
};

/**
 * Region selection for one display. Screenshot mode is freeze-frame: the frozen screenshot fills
 * the window. Recording mode ('record-region') is live: the window is transparent, so the desktop
 * underneath keeps running and shows through. Either way a 45% dim covers everything but the
 * selection, and the selection is edited with drag, handles or the keyboard: an arrow key starts a
 * centered selection, arrows move it (Shift: 10 px), Alt+arrows resize it, Enter confirms and Esc
 * cancels. Selections cannot leave this display (the pointer is clamped to the window).
 *
 * The pointer is ignored until the overlay is on screen (`data-ready`): main shows the window only
 * after the first paint, and an event that arrives earlier belongs to no visible UI. The selection
 * and the gesture live in refs as well as in state, so a handler never works from a stale render.
 */
export function RegionSelector({ init }: { init: OverlayInit }) {
  const { display, frameSize } = init;
  const live = init.mode === 'record-region';
  const size = display.bounds;
  const [selection, setSelectionState] = useState<Rect | null>(null);
  const [interaction, setInteractionState] = useState<Interaction>({ kind: 'none' });
  const [pointer, setPointer] = useState<Point | null>(null);
  const [hintUsed, setHintUsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const submitting = useRef(false);
  const selectionRef = useRef<Rect | null>(null);
  const interactionRef = useRef<Interaction>({ kind: 'none' });
  const readyRef = useRef(false);

  const setSelection = useCallback((next: Rect | null) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  const setInteraction = useCallback((next: Interaction) => {
    interactionRef.current = next;
    setInteractionState(next);
  }, []);

  // The frozen frame is decoded off-screen and painted onto a canvas. (An <img> + decode() in a
  // window that is still hidden was observed to wait a full second before it resolved.)
  const frameRef = useRef<HTMLCanvasElement>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 1800);
  }, []);

  const pixels = useCallback(
    (rect: Rect) => overlayRectToFramePixels(rect, display, frameSize),
    [display, frameSize],
  );
  const selectionPixels = selection ? pixels(selection) : null;
  const valid = selectionPixels?.ok === true;
  const selected = selection !== null && interaction.kind === 'none';

  const cancel = useCallback(() => {
    void window.framelet.invoke('overlay:cancel');
  }, []);

  const confirm = useCallback(async () => {
    const rect = selectionRef.current;
    if (!rect || submitting.current) return;
    if (!pixels(rect).ok) {
      showNotice('Select a larger area');
      return;
    }
    submitting.current = true;
    const result = await window.framelet.invoke('overlay:confirm', {
      displayId: init.displayId,
      rect,
    });
    submitting.current = false;
    if (!result.ok) showNotice(result.error.message);
  }, [pixels, init.displayId, showNotice]);

  // Keyboard: Esc, Enter, and the arrows (start, move, resize).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const onButton = event.target instanceof HTMLElement && event.target.closest('button');
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter' && !onButton) {
        event.preventDefault();
        void confirm();
      } else if (event.key.startsWith('Arrow') && interactionRef.current.kind === 'none') {
        event.preventDefault();
        setHintUsed(true);
        const current = selectionRef.current;
        if (!current) {
          setSelection(defaultSelection(size));
          return;
        }
        // One physical pixel per press (10 with Shift), converted to the overlay's DIP.
        const step = (event.shiftKey ? 10 : 1) * (size.width / frameSize.width);
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        setSelection(
          event.altKey ? growRect(current, dx, dy, size) : nudgeRect(current, dx, dy, size),
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, confirm, setSelection, size, frameSize.width]);

  // Main clears this overlay when a selection is started on another display.
  useEffect(
    () =>
      window.framelet.on('overlay:clearSelection', () => {
        setSelection(null);
        setInteraction({ kind: 'none' });
      }),
    [setSelection, setInteraction],
  );

  // Tell main the window is painted so it can show it (no black flash before the frozen frame).
  const [imageReady, setImageReady] = useState(false);
  useEffect(() => {
    const canvas = frameRef.current;
    if (!init.image || !canvas) return;
    const { width, height } = init.frameSize;
    if (init.image.byteLength === width * height * 4) {
      canvas.width = width;
      canvas.height = height;
      canvas
        .getContext('2d')
        ?.putImageData(new ImageData(bgraToRgba(init.image), width, height), 0, 0);
    }
    setImageReady(true);
  }, [init.image, init.frameSize, live]);

  // Live mode has nothing to paint (the desktop underneath is the picture): ready at once. Main
  // shows the window while it answers `overlay:ready`, so when the answer is here it is on screen.
  const painted = live || imageReady;
  useEffect(() => {
    if (!painted) return;
    let active = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(
        () =>
          void window.framelet.invoke('overlay:ready').then(() => {
            if (!active) return;
            readyRef.current = true;
            setReady(true);
            rootRef.current?.focus({ preventScroll: true });
          }),
      ),
    );
    return () => {
      active = false;
    };
  }, [painted]);

  const localPoint = (event: PointerEvent): { point: Point; clamped: Point; atEdge: boolean } => {
    const box = rootRef.current?.getBoundingClientRect();
    const point = { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
    const clamped = clampPoint(point, size);
    const atEdge =
      point.x <= 0 || point.y <= 0 || point.x >= size.width - 1 || point.y >= size.height - 1;
    return { point, clamped, atEdge };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !readyRef.current) return;
    const { clamped } = localPoint(event);
    const handle = (event.target as HTMLElement).dataset.handle as HandleId | undefined;
    const current = selectionRef.current;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (handle && current) {
      setInteraction({ kind: 'resizing', handle, start: current });
      return;
    }
    if (current && pointInRect(clamped, current)) {
      // Dragging inside the selection moves it; a plain double click confirms.
      setInteraction({ kind: 'moving', origin: clamped, start: current });
      return;
    }
    setHintUsed(true);
    setSelection(null);
    setInteraction({ kind: 'drawing', origin: clamped });
    void window.framelet.invoke('overlay:selectionStarted');
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!readyRef.current) return;
    const { clamped, atEdge } = localPoint(event);
    if (interactionRef.current.kind === 'none' || (event.buttons & 1) !== 0) setPointer(clamped);
    const gesture = interactionRef.current;
    // While a gesture runs the primary button is down. A move that says otherwise is not the
    // gesture's pointer: Chromium also dispatches a synthetic move at the physical cursor after a
    // layout change, and with an injected (automated) drag that cursor is somewhere else entirely.
    if (gesture.kind !== 'none' && (event.buttons & 1) === 0) return;
    if (gesture.kind === 'drawing') {
      setSelection(normalizeDragRect(gesture.origin, clamped));
      if (atEdge) showNotice('Selections stay on one screen');
    } else if (gesture.kind === 'moving') {
      const { origin, start } = gesture;
      setSelection(nudgeRect(start, clamped.x - origin.x, clamped.y - origin.y, size));
    } else if (gesture.kind === 'resizing') {
      setSelection(resizeRect(gesture.start, gesture.handle, clamped));
      if (atEdge) showNotice('Selections stay on one screen');
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (interactionRef.current.kind === 'none') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setInteraction({ kind: 'none' });
    const rect = selectionRef.current;
    if (rect && !pixels(rect).ok) {
      setSelection(null);
      showNotice('Drag to select a larger area');
    }
  };

  const onDoubleClick = (event: PointerEvent<HTMLDivElement> | React.MouseEvent): void => {
    const rect = selectionRef.current;
    if (!rect || !readyRef.current) return;
    const { point } = localPoint(event as PointerEvent);
    if (pointInRect(point, rect)) void confirm();
  };

  const label = selectionPixels?.ok
    ? `${selectionPixels.rect.width} × ${selectionPixels.rect.height}`
    : selection
      ? '—'
      : null;
  const drawing = interaction.kind === 'drawing' || interaction.kind === 'resizing';
  const bar = selected && selection ? placeActionBar(selection, BAR_SIZE, size) : null;

  return (
    <div
      ref={rootRef}
      data-testid="overlay-region"
      data-display-id={init.displayId}
      data-live={live}
      data-ready={ready}
      data-selection={selection ? JSON.stringify(selection) : ''}
      data-size-label={label ?? ''}
      className={cn(
        'fixed inset-0 overflow-hidden rounded-none outline-none select-none',
        !live && 'bg-black',
      )}
      style={{ cursor: 'crosshair' }}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(event) => {
        event.preventDefault();
        if (selectionRef.current) setSelection(null);
        else cancel();
      }}
    >
      {live ? null : (
        <canvas
          ref={frameRef}
          aria-hidden="true"
          data-testid="frozen-frame"
          className="pointer-events-none absolute inset-0 size-full"
        />
      )}

      {selection ? (
        <div
          data-testid="selection-box"
          className="absolute"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
            boxShadow: `0 0 0 1px rgb(255 255 255 / 0.95), 0 0 0 100vmax ${DIM}`,
            // A fully transparent window region may not receive pointer events; keep the hole
            // (live mode) at 1% black so moving and double clicking work inside it.
            ...(live && { background: 'rgb(0 0 0 / 0.01)' }),
            cursor: selected ? 'move' : 'crosshair',
          }}
        >
          {selected
            ? HANDLE_IDS.map((id) => (
                <span
                  key={id}
                  data-handle={id}
                  className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-[1.5px] border-accent-solid bg-white shadow-card"
                  style={HANDLE_STYLE[id]}
                />
              ))
            : null}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0" style={{ background: DIM }} />
      )}

      {label && selection && (pointer !== null || !drawing) ? (
        <OverlayChip
          testId="size-label"
          className="absolute tabular-nums"
          style={
            drawing && pointer !== null
              ? {
                  left: Math.min(pointer.x + 16, size.width - 110),
                  top: Math.min(pointer.y + 18, size.height - 36),
                }
              : {
                  left: Math.min(selection.x, size.width - 110),
                  top: selection.y >= 36 ? selection.y - 32 : selection.y + 8,
                }
          }
        >
          {label}
        </OverlayChip>
      ) : null}

      {bar ? (
        <div
          role="group"
          aria-label="Selection actions"
          className="absolute flex items-center gap-2 rounded-xl border border-line bg-surface p-1.5 shadow-raised"
          style={{ left: bar.x, top: bar.y, width: BAR_SIZE.width, height: BAR_SIZE.height }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          data-testid="action-bar"
        >
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            disabled={!valid}
            onClick={() => void confirm()}
            data-testid="overlay-capture"
          >
            {live ? 'Record' : 'Capture'}
            <Kbd keys={['Enter']} />
          </Button>
          <Button variant="secondary" size="sm" onClick={cancel} data-testid="overlay-cancel">
            Cancel
            <Kbd keys={['Esc']} />
          </Button>
        </div>
      ) : null}

      <div
        className={cn(
          'pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 transition-opacity duration-300',
          notice || !hintUsed ? 'opacity-100' : 'opacity-0',
        )}
        data-testid="overlay-hint"
        role="status"
        aria-live="polite"
      >
        <OverlayChip className="px-4 py-2 text-[13px]">
          {notice ??
            `Drag or use the arrow keys to select an area · Enter to ${live ? 'record' : 'capture'} · Esc to cancel`}
        </OverlayChip>
      </div>
    </div>
  );
}
