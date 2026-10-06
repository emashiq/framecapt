import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Maximize, Scissors, ZoomIn, ZoomOut } from 'lucide-react';
import {
  MIN_CUT_MS,
  MIN_ITEM_MS,
  MIN_SEGMENT_MS,
  isVisual,
  normalizeCuts,
  type AudioItem,
  type Item,
  type VideoCommand,
  type VideoProject,
} from '../../../shared/video-edit';
import { IconButton } from '../../components/ui/IconButton';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/cn';
import { KIND_STYLES } from './item-kinds';
import type { Player } from './player';
import {
  clampZoom,
  formatRulerLabel,
  formatTimecode,
  packLanes,
  scrollAfterZoom,
  sliderToZoom,
  snapTime,
  tickSpec,
  ticksBetween,
  zoomLimits,
  zoomToSlider,
} from './timeline-math';

export type TimelineSelection = { kind: 'item' | 'cut'; id: string } | null;
export interface TimeRange {
  startMs: number;
  endMs: number;
}

const PAD = 12;
const RULER_H = 28;
const CLIP_H = 40;
const LANE_H = 26;
const GAP = 8;
const SNAP_PX = 8;
const MIN_BAR_PX = 6;

export interface TimelineProps {
  project: VideoProject;
  player: Player;
  selection: TimelineSelection;
  onSelect: (selection: TimelineSelection) => void;
  range: TimeRange | null;
  onRange: (range: TimeRange | null) => void;
  commit: (command: VideoCommand, gesture?: string) => void;
  endGesture: () => void;
  onCutRange: () => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
}

/** Follows a pointer drag with window listeners (the dragged element may re-render meanwhile). */
function trackPointer(
  event: ReactPointerEvent,
  move: (dxPx: number, event: PointerEvent) => void,
  up: (moved: boolean, event: PointerEvent) => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  const x0 = event.clientX;
  let moved = false;
  const onMove = (e: PointerEvent): void => {
    if (Math.abs(e.clientX - x0) > 2) moved = true;
    move(e.clientX - x0, e);
  };
  const onUp = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    up(moved, e);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * The timeline: a ruler, the recording as one clip (trim handles on its ends, cut pieces hatched),
 * one row per overlapping group of items, and the playhead. Plain DOM: only the ticks in view are
 * made, so an hour-long recording costs no more than a minute-long one. Times are source times.
 */
export function Timeline(props: TimelineProps) {
  const { project, player, selection, range } = props;
  const duration = project.source.durationMs;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [guide, setGuide] = useState<number | null>(null);
  const pendingScroll = useRef<number | null>(null);

  const limits = useMemo(() => zoomLimits(duration, viewport - PAD * 2), [duration, viewport]);
  const px = zoom === 'fit' ? limits.min : clampZoom(zoom, limits);
  const x = (ms: number): number => PAD + ms * px;
  const width = Math.ceil(duration * px + PAD * 2);

  const live = useRef({ px, project, props });
  useLayoutEffect(() => {
    live.current = { px, project, props };
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (): void => setViewport(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scroller.current) {
      // The scroll event that follows updates `scrollLeft`.
      scroller.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  });

  const zoomTo = useCallback(
    (next: number, anchorPx?: number) => {
      const el = scroller.current;
      const anchor = anchorPx ?? (el ? el.clientWidth / 2 : 0);
      const target = clampZoom(next, limits);
      if (el) {
        pendingScroll.current = scrollAfterZoom(el.scrollLeft, anchor, live.current.px, target);
      }
      setZoom(target <= limits.min * 1.0001 ? 'fit' : target);
    },
    [limits],
  );

  // Ctrl + wheel zooms around the pointer; a plain wheel scrolls sideways.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) {
        event.preventDefault();
        const anchor = event.clientX - el.getBoundingClientRect().left;
        zoomTo(live.current.px * Math.exp(-event.deltaY * 0.0015), anchor);
      } else if (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        el.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Playing: keep the playhead in view.
  useEffect(
    () =>
      player.subscribe(() => {
        const el = scroller.current;
        const snapshot = player.getSnapshot();
        if (!el || !snapshot.playing) return;
        const at = PAD + snapshot.timeMs * live.current.px;
        if (at < el.scrollLeft + 24 || at > el.scrollLeft + el.clientWidth - 24) {
          el.scrollLeft = Math.max(0, at - el.clientWidth * 0.2);
        }
      }),
    [player],
  );

  const msAt = (clientX: number): number => {
    const rect = content.current?.getBoundingClientRect();
    return rect ? (clientX - rect.left - PAD) / px : 0;
  };

  const snapTargets = (skipItem?: string): number[] => {
    const targets = [
      0,
      duration,
      player.getSnapshot().timeMs,
      project.trim.startMs,
      project.trim.endMs,
    ];
    for (const cut of project.cuts) targets.push(cut.startMs, cut.endMs);
    for (const item of project.items) {
      if (item.id !== skipItem) targets.push(item.startMs, item.endMs);
    }
    if (range) targets.push(range.startMs, range.endMs);
    return targets;
  };

  // --- scrubbing ---

  const scrub = (event: ReactPointerEvent): void => {
    const seek = (clientX: number): void => player.seek(clamp(msAt(clientX), 0, duration));
    seek(event.clientX);
    trackPointer(
      event,
      (_dx, e) => seek(e.clientX),
      () => undefined,
    );
  };

  // --- trim ---

  const dragTrim = (event: ReactPointerEvent, edge: 'start' | 'end'): void => {
    const targets = snapTargets();
    const origin = project.trim;
    trackPointer(
      event,
      (dx, e) => {
        const wanted = (edge === 'start' ? origin.startMs : origin.endMs) + dx / px;
        const snapped = e.altKey ? wanted : snapTime(wanted, targets, SNAP_PX / px).ms;
        const startMs =
          edge === 'start' ? clamp(snapped, 0, origin.endMs - MIN_SEGMENT_MS) : origin.startMs;
        const endMs =
          edge === 'end' ? clamp(snapped, origin.startMs + MIN_SEGMENT_MS, duration) : origin.endMs;
        setGuide(edge === 'start' ? startMs : endMs);
        props.commit(
          { type: 'setTrim', startMs: Math.round(startMs), endMs: Math.round(endMs) },
          'trim',
        );
      },
      () => {
        setGuide(null);
        props.endGesture();
      },
    );
  };

  // --- items ---

  const dragItem = (event: ReactPointerEvent, item: Item, mode: 'move' | 'start' | 'end'): void => {
    props.onSelect({ kind: 'item', id: item.id });
    const targets = snapTargets(item.id);
    const threshold = SNAP_PX / px;
    trackPointer(
      event,
      (dx, e) => {
        const delta = dx / px;
        let startMs = item.startMs;
        let endMs = item.endMs;
        let target: number | null = null;
        const snap = (value: number): { ms: number; target: number | null } =>
          e.altKey ? { ms: value, target: null } : snapTime(value, targets, threshold);
        if (mode === 'move') {
          const a = snap(item.startMs + delta);
          const b = snap(item.endMs + delta);
          // Whichever edge is closer to a target pulls the whole bar onto it.
          const missA = a.target === null ? Infinity : Math.abs(a.ms - (item.startMs + delta));
          const missB = b.target === null ? Infinity : Math.abs(b.ms - (item.endMs + delta));
          let shift = delta;
          if (missA <= missB && missA !== Infinity) {
            shift = a.ms - item.startMs;
            target = a.target;
          } else if (missB !== Infinity) {
            shift = b.ms - item.endMs;
            target = b.target;
          }
          const clamped = clamp(shift, -item.startMs, duration - item.endMs);
          startMs = item.startMs + clamped;
          endMs = item.endMs + clamped;
        } else if (mode === 'start') {
          const snapped = snap(item.startMs + delta);
          target = snapped.target;
          // A clip cannot start before the start of its file: its head is trimmed by moving `inMs`.
          const earliest = item.kind === 'audio' ? Math.max(0, item.startMs - item.inMs) : 0;
          startMs = clamp(snapped.ms, earliest, item.endMs - MIN_ITEM_MS);
        } else {
          const snapped = snap(item.endMs + delta);
          target = snapped.target;
          // ... nor run past the end of its file.
          const latest =
            item.kind === 'audio'
              ? Math.min(duration, item.startMs + item.clipMs - item.inMs)
              : duration;
          endMs = clamp(snapped.ms, item.startMs + MIN_ITEM_MS, latest);
        }
        setGuide(target);
        props.commit(
          {
            type: 'updateItem',
            id: item.id,
            patch: {
              startMs: Math.round(startMs),
              endMs: Math.round(endMs),
              // The head of a clip moves with its start so the sound stays where it was.
              ...(item.kind === 'audio' &&
                mode === 'start' && { inMs: Math.round(item.inMs + (startMs - item.startMs)) }),
            },
          },
          `item:${item.id}`,
        );
      },
      () => {
        setGuide(null);
        props.endGesture();
      },
    );
  };

  // --- range selection on the clip ---

  const dragRange = (event: ReactPointerEvent): void => {
    const origin = clamp(msAt(event.clientX), 0, duration);
    const targets = snapTargets();
    trackPointer(
      event,
      (_dx, e) => {
        const here = clamp(msAt(e.clientX), 0, duration);
        const snapped = e.altKey ? here : snapTime(here, targets, SNAP_PX / px).ms;
        const startMs = Math.max(project.trim.startMs, Math.min(origin, snapped));
        const endMs = Math.min(project.trim.endMs, Math.max(origin, snapped));
        props.onRange(
          endMs - startMs >= MIN_CUT_MS
            ? { startMs: Math.round(startMs), endMs: Math.round(endMs) }
            : null,
        );
      },
      (moved) => {
        if (!moved) {
          props.onRange(null);
          props.onSelect(null);
          player.seek(origin);
        } else {
          props.onSelect(null);
        }
      },
    );
  };

  // --- layout ---

  const visualItems = useMemo(() => project.items.filter(isVisual), [project.items]);
  const audioItems = useMemo(
    () => project.items.filter((item): item is AudioItem => item.kind === 'audio'),
    [project.items],
  );
  const { lanes, count } = useMemo(() => packLanes(visualItems), [visualItems]);
  const audioLanes = useMemo(() => packLanes(audioItems), [audioItems]);
  const lanesTop = RULER_H + CLIP_H + GAP;
  // The audio track sits under the items, with its own rows (clips may overlap).
  const audioTop = lanesTop + count * LANE_H + GAP;
  const totalHeight = audioTop + audioLanes.count * LANE_H + GAP;
  const spec = tickSpec(px);
  const ticks = ticksBetween(
    spec,
    (scrollLeft - PAD) / px - spec.step,
    (scrollLeft + viewport) / px + spec.step,
    duration,
  );
  const cuts = useMemo(
    () => normalizeCuts(project.trim, project.cuts),
    [project.trim, project.cuts],
  );

  return (
    <section
      aria-label="Timeline"
      data-testid="video-timeline"
      className="flex h-[272px] shrink-0 flex-col border-t border-line bg-surface-2"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
        <Button
          size="sm"
          variant="ghost"
          data-testid="mark-in"
          onClick={props.onMarkIn}
          aria-keyshortcuts="I"
        >
          Mark in
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="mark-out"
          onClick={props.onMarkOut}
          aria-keyshortcuts="O"
        >
          Mark out
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="cut-range"
          icon={<Scissors className="size-4" aria-hidden="true" />}
          unavailable={range === null}
          onClick={props.onCutRange}
          title={range ? undefined : 'Select a range first: drag on the clip, or press I and O'}
        >
          Cut selection
        </Button>
        {range ? (
          <span className="ml-1 text-xs text-fg-muted tabular-nums" data-testid="range-readout">
            {formatTimecode(range.startMs)} – {formatTimecode(range.endMs)}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            size="sm"
            aria-label="Zoom out"
            icon={<ZoomOut className="size-4" aria-hidden="true" />}
            onClick={() => zoomTo(px / 1.5)}
          />
          <input
            type="range"
            min={0}
            max={1000}
            aria-label="Timeline zoom"
            data-testid="timeline-zoom"
            value={Math.round(zoomToSlider(px, limits) * 1000)}
            onChange={(event) => zoomTo(sliderToZoom(Number(event.target.value) / 1000, limits))}
            className="h-1 w-28 accent-(--accent-solid)"
          />
          <IconButton
            size="sm"
            aria-label="Zoom in"
            icon={<ZoomIn className="size-4" aria-hidden="true" />}
            onClick={() => zoomTo(px * 1.5)}
          />
          <IconButton
            size="sm"
            aria-label="Fit the whole recording"
            data-testid="timeline-fit"
            icon={<Maximize className="size-4" aria-hidden="true" />}
            onClick={() => zoomTo(0)}
          />
        </div>
      </div>

      <div
        ref={scroller}
        data-testid="timeline-scroll"
        className="relative min-h-0 flex-1 overflow-auto"
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      >
        <div ref={content} className="relative" style={{ width, height: Math.max(totalHeight, 1) }}>
          {/* Ruler */}
          <div
            data-testid="timeline-ruler"
            className="absolute inset-x-0 top-0 cursor-col-resize border-b border-line bg-surface"
            style={{ height: RULER_H }}
            onPointerDown={scrub}
          >
            {ticks.map((tick) => (
              <div
                key={tick.ms}
                className="pointer-events-none absolute bottom-0"
                style={{ left: x(tick.ms) }}
              >
                <div className={cn('w-px bg-line-strong', tick.major ? 'h-3' : 'h-1.5')} />
                {tick.major ? (
                  <span className="absolute top-[-14px] left-1 text-[10px] leading-none whitespace-nowrap text-fg-subtle tabular-nums">
                    {formatRulerLabel(tick.ms, spec.step)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          {/* The clip: the recording, dimmed outside the trim, hatched where cut */}
          <div
            data-testid="timeline-clip"
            className="absolute inset-x-0 cursor-crosshair"
            style={{ top: RULER_H + 4, height: CLIP_H }}
            onPointerDown={dragRange}
          >
            <div
              className="absolute inset-y-0 rounded-md bg-surface-3"
              style={{ left: x(0), width: duration * px }}
            />
            <div
              data-testid="timeline-trimmed"
              className="absolute inset-y-0 rounded-md border border-accent bg-accent-soft"
              style={{
                left: x(project.trim.startMs),
                width: (project.trim.endMs - project.trim.startMs) * px,
              }}
            />
            {cuts.map((cut) => {
              const selected = selection?.kind === 'cut' && selection.id === cut.id;
              return (
                <button
                  key={cut.id}
                  type="button"
                  data-testid="timeline-cut"
                  aria-label={`Cut ${formatTimecode(cut.startMs)} to ${formatTimecode(cut.endMs)}. Press Delete to restore it.`}
                  aria-pressed={selected}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => props.onSelect({ kind: 'cut', id: cut.id })}
                  className={cn(
                    'cut-hatch absolute inset-y-0 border-x border-fg-subtle',
                    selected && 'outline-2 outline-offset-0 outline-(--accent)',
                  )}
                  style={{
                    left: x(cut.startMs),
                    width: Math.max(MIN_BAR_PX, (cut.endMs - cut.startMs) * px),
                  }}
                />
              );
            })}
            {(['start', 'end'] as const).map((edge) => (
              <div
                key={edge}
                role="slider"
                tabIndex={0}
                data-testid={`trim-${edge}`}
                aria-label={edge === 'start' ? 'Trim start' : 'Trim end'}
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={edge === 'start' ? project.trim.startMs : project.trim.endMs}
                aria-valuetext={formatTimecode(
                  edge === 'start' ? project.trim.startMs : project.trim.endMs,
                )}
                onPointerDown={(event) => dragTrim(event, edge)}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 1000 : player.frameMs;
                  const direction =
                    event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (!direction) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const { startMs, endMs } = project.trim;
                  props.commit(
                    edge === 'start'
                      ? {
                          type: 'setTrim',
                          startMs: Math.round(
                            clamp(startMs + direction * step, 0, endMs - MIN_SEGMENT_MS),
                          ),
                          endMs,
                        }
                      : {
                          type: 'setTrim',
                          startMs,
                          endMs: Math.round(
                            clamp(endMs + direction * step, startMs + MIN_SEGMENT_MS, duration),
                          ),
                        },
                  );
                }}
                className="absolute inset-y-0 z-10 flex w-3 cursor-ew-resize items-center justify-center"
                style={{
                  left:
                    x(edge === 'start' ? project.trim.startMs : project.trim.endMs) -
                    (edge === 'start' ? 1 : 11),
                }}
              >
                <span className="h-5 w-1 rounded-full bg-accent-solid" />
              </div>
            ))}
          </div>

          {/* The range to cut */}
          {range ? (
            <div
              data-testid="timeline-range"
              className="pointer-events-none absolute z-10 border-x-2 border-accent-solid bg-accent-solid/20"
              style={{
                left: x(range.startMs),
                width: Math.max(2, (range.endMs - range.startMs) * px),
                top: RULER_H + 4,
                height: CLIP_H,
              }}
            />
          ) : null}

          {/* Items, one row per overlapping group */}
          {visualItems.map((item) => (
            <ItemBar
              key={item.id}
              item={item}
              selected={selection?.kind === 'item' && selection.id === item.id}
              left={x(item.startMs)}
              width={Math.max(MIN_BAR_PX, (item.endMs - item.startMs) * px)}
              top={lanesTop + (lanes.get(item.id) ?? 0) * LANE_H}
              onSelect={() => props.onSelect({ kind: 'item', id: item.id })}
              onDrag={dragItem}
            />
          ))}

          {/* The audio track: clips on their own rows */}
          <div
            data-testid="timeline-audio-track"
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line"
            style={{ top: audioTop - GAP / 2, height: audioLanes.count * LANE_H + GAP }}
          >
            {audioItems.length === 0 ? (
              <span className="sticky left-3 inline-block px-3 pt-1 text-[11px] text-fg-subtle">
                Audio track: add a sound or music clip
              </span>
            ) : null}
          </div>
          {audioItems.map((item) => (
            <ItemBar
              key={item.id}
              item={item}
              selected={selection?.kind === 'item' && selection.id === item.id}
              left={x(item.startMs)}
              width={Math.max(MIN_BAR_PX, (item.endMs - item.startMs) * px)}
              top={audioTop + (audioLanes.lanes.get(item.id) ?? 0) * LANE_H}
              onSelect={() => props.onSelect({ kind: 'item', id: item.id })}
              onDrag={dragItem}
            />
          ))}

          {guide !== null ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-20 w-px bg-warning"
              style={{ left: x(guide) }}
            />
          ) : null}
          <Playhead player={player} px={px} />
        </div>
      </div>
    </section>
  );
}

/** What a bar says: its kind, or for text and audio what it holds (the text's first line, the file's name). */
function barLabel(item: Item): string {
  if (item.kind === 'text') return item.text.split(/\r?\n/)[0] || KIND_STYLES.text.label;
  if (item.kind === 'audio') return item.name || KIND_STYLES.audio.label;
  return KIND_STYLES[item.kind].label;
}

const ItemBar = memo(function ItemBar(props: {
  item: Item;
  selected: boolean;
  left: number;
  width: number;
  top: number;
  onSelect: () => void;
  onDrag: (event: ReactPointerEvent, item: Item, mode: 'move' | 'start' | 'end') => void;
}) {
  const { item } = props;
  const style = KIND_STYLES[item.kind];
  const Icon = style.icon;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      aria-label={`${style.label}, ${formatTimecode(item.startMs)} to ${formatTimecode(item.endMs)}`}
      data-testid={`timeline-item-${item.kind}`}
      data-selected={props.selected || undefined}
      onPointerDown={(event) => props.onDrag(event, item, 'move')}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          props.onSelect();
        }
      }}
      className={cn(
        'absolute flex h-6 cursor-grab items-center gap-1 overflow-hidden rounded-md border px-2 text-[11px] font-medium select-none active:cursor-grabbing',
        style.bar,
        props.selected && 'ring-2 ring-(--accent) ring-offset-1 ring-offset-(--surface-2)',
      )}
      style={{ left: props.left, width: props.width, top: props.top }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize"
        onPointerDown={(event) => props.onDrag(event, item, 'start')}
      />
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{barLabel(item)}</span>
      <span
        aria-hidden="true"
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize"
        onPointerDown={(event) => props.onDrag(event, item, 'end')}
      />
    </div>
  );
});

/** The playhead: a line over the whole timeline and a grip on the ruler, moved by the player. */
function Playhead({ player, px }: { player: Player; px: number }) {
  const { timeMs } = useSyncExternalStore(player.subscribe, player.getSnapshot);
  return (
    <div
      aria-hidden="true"
      data-testid="playhead"
      className="pointer-events-none absolute inset-y-0 left-0 z-30 w-px bg-danger-solid"
      style={{ transform: `translateX(${PAD + timeMs * px}px)` }}
    >
      <span className="absolute top-0 -left-[5px] size-[11px] rounded-b-md bg-danger-solid [clip-path:polygon(0_0,100%_0,50%_100%)]" />
    </div>
  );
}
