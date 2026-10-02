import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Kbd } from '../../components/ui/Kbd';
import { cn } from '../../lib/cn';
import { bgraToRgba } from '../../../shared/pixels';
import { overlayRectToFramePixels, normalizeDragRect, type Point } from '../../../shared/geometry';
import type { Rect } from '../../../shared/rect';
import {
  clampPoint,
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
 * selection, and the selection is edited with drag, handles, arrow keys and Enter/Esc. Selections
 * cannot leave this display (the pointer is clamped to the window).
 */
export function RegionSelector({ init }: { init: OverlayInit }) {
  const { display, frameSize } = init;
  const live = init.mode === 'record-region';
  const size = display.bounds;
  const [selection, setSelection] = useState<Rect | null>(null);
  const [interaction, setInteraction] = useState<Interaction>({ kind: 'none' });
  const [pointer, setPointer] = useState<Point | null>(null);
  const [hintUsed, setHintUsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const submitting = useRef(false);

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
    if (!selection || submitting.current) return;
    if (!pixels(selection).ok) {
      showNotice('Select a larger area');
      return;
    }
    submitting.current = true;
    const result = await window.framelet.invoke('overlay:confirm', {
      displayId: init.displayId,
      rect: selection,
    });
    submitting.current = false;
    if (!result.ok) showNotice(result.error.message);
  }, [selection, pixels, init.displayId, showNotice]);

  // Keyboard: Enter / Esc / arrow nudges.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void confirm();
      } else if (selection && interaction.kind === 'none' && event.key.startsWith('Arrow')) {
        event.preventDefault();
        // One physical pixel per press (10 with Shift), converted to the overlay's DIP.
        const step = (event.shiftKey ? 10 : 1) * (size.width / frameSize.width);
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        setSelection(nudgeRect(selection, dx, dy, size));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, confirm, selection, interaction.kind, size, frameSize.width]);

  // Main clears this overlay when a selection is started on another display.
  useEffect(
    () =>
      window.framelet.on('overlay:clearSelection', () => {
        setSelection(null);
        setInteraction({ kind: 'none' });
      }),
    [],
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

  // Live mode has nothing to paint (the desktop underneath is the picture): ready at once.
  const painted = live || imageReady;
  useEffect(() => {
    if (!painted) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => void window.framelet.invoke('overlay:ready')),
    );
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
    if (event.button !== 0) return;
    const { clamped } = localPoint(event);
    const handle = (event.target as HTMLElement).dataset.handle as HandleId | undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (handle && selection) {
      setInteraction({ kind: 'resizing', handle, start: selection });
      return;
    }
    if (selection && pointInRect(clamped, selection)) {
      // Dragging inside the selection moves it; a plain double click confirms.
      setInteraction({ kind: 'moving', origin: clamped, start: selection });
      return;
    }
    setHintUsed(true);
    setSelection(null);
    setInteraction({ kind: 'drawing', origin: clamped });
    void window.framelet.invoke('overlay:selectionStarted');
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const { clamped, atEdge } = localPoint(event);
    setPointer(clamped);
    if (interaction.kind === 'drawing') {
      setSelection(normalizeDragRect(interaction.origin, clamped));
      if (atEdge) showNotice('Selections stay on one screen');
    } else if (interaction.kind === 'moving') {
      const { origin, start } = interaction;
      setSelection(nudgeRect(start, clamped.x - origin.x, clamped.y - origin.y, size));
    } else if (interaction.kind === 'resizing') {
      setSelection(resizeRect(interaction.start, interaction.handle, clamped));
      if (atEdge) showNotice('Selections stay on one screen');
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (interaction.kind === 'none') return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setInteraction({ kind: 'none' });
    if (selection && !pixels(selection).ok) {
      setSelection(null);
      showNotice('Drag to select a larger area');
    }
  };

  const onDoubleClick = (event: PointerEvent<HTMLDivElement> | React.MouseEvent): void => {
    if (!selection) return;
    const { point } = localPoint(event as PointerEvent);
    if (pointInRect(point, selection)) void confirm();
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
      data-selection={selection ? JSON.stringify(selection) : ''}
      data-size-label={label ?? ''}
      className={cn('fixed inset-0 overflow-hidden select-none', !live && 'bg-black')}
      style={{ cursor: 'crosshair' }}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(event) => {
        event.preventDefault();
        if (selection) setSelection(null);
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

      {label && selection && pointer !== null ? (
        <OverlayChip
          testId="size-label"
          className="absolute tabular-nums"
          style={
            drawing
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
        aria-live="polite"
      >
        <OverlayChip className="px-4 py-2 text-[13px]">
          {notice ??
            `Drag to select an area · Enter to ${live ? 'record' : 'capture'} · Esc to cancel`}
        </OverlayChip>
      </div>
    </div>
  );
}
