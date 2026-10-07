/** Pure helpers of the timeline: ticks, time text, snapping, zoom and lanes. Times are milliseconds. */

// --- ticks ------------------------------------------------------------------------------------

/** Distance between labelled ticks, and how many parts it is divided into by the small ticks. */
const TICK_STEPS: readonly (readonly [step: number, parts: number])[] = [
  [10, 5],
  [20, 4],
  [50, 5],
  [100, 5],
  [200, 4],
  [500, 5],
  [1000, 5],
  [2000, 4],
  [5000, 5],
  [10_000, 5],
  [15_000, 3],
  [30_000, 6],
  [60_000, 6],
  [120_000, 4],
  [300_000, 5],
  [600_000, 5],
  [1_800_000, 6],
  [3_600_000, 6],
];

export interface TickSpec {
  /** Milliseconds between labelled ticks. */
  step: number;
  /** Milliseconds between small ticks. */
  minor: number;
}

/** The smallest step whose labels are at least `minLabelPx` apart at this zoom. */
export function tickSpec(pxPerMs: number, minLabelPx = 88): TickSpec {
  const wanted = minLabelPx / pxPerMs;
  const entry = TICK_STEPS.find(([step]) => step >= wanted) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const [step, parts] = entry ?? [3_600_000, 6];
  return { step, minor: step / parts };
}

export interface Tick {
  ms: number;
  major: boolean;
}

/** The ticks in [fromMs, toMs] (a little beyond, so a label at the edge is not cut off). */
export function ticksBetween(spec: TickSpec, fromMs: number, toMs: number, endMs: number): Tick[] {
  const ticks: Tick[] = [];
  const first = Math.max(0, Math.floor(fromMs / spec.minor) * spec.minor);
  const last = Math.min(endMs, toMs);
  for (let ms = first; ms <= last + 1e-6; ms += spec.minor) {
    const rounded = Math.round(ms);
    ticks.push({ ms: rounded, major: rounded % spec.step === 0 });
  }
  return ticks;
}

// --- time text --------------------------------------------------------------------------------

const two = (value: number): string => String(value).padStart(2, '0');

/** "1:05.250", "1:02:03.500": minutes and seconds with milliseconds (hours when needed). */
export function formatTimecode(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  const tail = `${two(seconds)}.${String(millis).padStart(3, '0')}`;
  return hours > 0 ? `${hours}:${two(minutes)}:${tail}` : `${minutes}:${tail}`;
}

/** The label of a ruler tick: whole seconds as "0:05", finer steps with decimals ("0:05.5"). */
export function formatRulerLabel(ms: number, step: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  let tail = two(seconds);
  if (step < 1000) {
    const digits = step < 100 ? 3 : step < 1000 ? 1 : 0;
    tail += `.${String(millis).padStart(3, '0').slice(0, digits)}`;
  }
  return hours > 0 ? `${hours}:${two(minutes)}:${tail}` : `${minutes}:${tail}`;
}

// --- snapping ---------------------------------------------------------------------------------

/** The target closest to `ms` within `thresholdMs`, or the time itself. */
export function snapTime(
  ms: number,
  targets: readonly number[],
  thresholdMs: number,
): { ms: number; target: number | null } {
  let best: number | null = null;
  for (const target of targets) {
    if (
      Math.abs(target - ms) <= thresholdMs &&
      (best === null || Math.abs(target - ms) < Math.abs(best - ms))
    ) {
      best = target;
    }
  }
  return best === null ? { ms, target: null } : { ms: best, target: best };
}

// --- zoom -------------------------------------------------------------------------------------

/** Most zoomed out (the whole recording fits) and most zoomed in (one pixel is 5 ms), in px per ms. */
export function zoomLimits(durationMs: number, viewportPx: number): { min: number; max: number } {
  const min = Math.max(viewportPx, 100) / Math.max(durationMs, 1);
  return { min, max: Math.max(min, 0.2) };
}

export function clampZoom(pxPerMs: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, pxPerMs));
}

/** Slider position 0..1 <-> zoom, on a log scale (so each step feels the same). */
export function zoomToSlider(pxPerMs: number, limits: { min: number; max: number }): number {
  if (limits.max <= limits.min) return 0;
  return Math.log(pxPerMs / limits.min) / Math.log(limits.max / limits.min);
}
export function sliderToZoom(position: number, limits: { min: number; max: number }): number {
  return limits.min * Math.pow(limits.max / limits.min, Math.min(1, Math.max(0, position)));
}

/** The scroll offset that keeps the time under `anchorPx` (a viewport x) in place after a zoom. */
export function scrollAfterZoom(
  scrollLeft: number,
  anchorPx: number,
  oldPxPerMs: number,
  newPxPerMs: number,
): number {
  const anchorMs = (scrollLeft + anchorPx) / oldPxPerMs;
  return Math.max(0, anchorMs * newPxPerMs - anchorPx);
}

// --- lanes ------------------------------------------------------------------------------------

export interface Span {
  id: string;
  startMs: number;
  endMs: number;
}

/**
 * Puts spans on rows so none overlaps another on its row: each goes on the first row that is free
 * where it starts. Stable: the order of the spans in the project is kept for equal starts.
 */
export function packLanes(spans: readonly Span[]): { lanes: Map<string, number>; count: number } {
  const ends: number[] = [];
  const lanes = new Map<string, number>();
  const order = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.startMs - b.span.startMs || a.index - b.index);
  for (const { span } of order) {
    let lane = ends.findIndex((end) => end <= span.startMs);
    if (lane < 0) {
      lane = ends.length;
      ends.push(span.endMs);
    } else {
      ends[lane] = span.endMs;
    }
    lanes.set(span.id, lane);
  }
  return { lanes, count: Math.max(1, ends.length) };
}
