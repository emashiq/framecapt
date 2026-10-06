import type { Point } from '../../shared/geometry';

/** One reading of the pointer: global DIP and a monotonic time in ms. */
export interface CursorSample extends Point {
  t: number;
}

export interface DetectorOptions {
  /** The pointer must have moved farther than this (DIP) from the last step to count as "went to an item". */
  moveThreshold: number;
  /** "At rest" means staying within this radius (DIP) ... */
  restRadius: number;
  /** ... for this long (ms). */
  dwellMs: number;
  /** Two steps are never closer than this (ms). */
  minIntervalMs: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  moveThreshold: 24,
  restRadius: 6,
  dwellMs: 700,
  minIntervalMs: 1500,
};

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Finds the moments a person points at something: the pointer travels, then rests. Pure and fed
 * samples one at a time (the controller polls `screen.getCursorScreenPoint()`; no global hooks are
 * installed, see ADR-033). `feed` returns the sample at which a step should be captured, once per
 * rest. The first rest after starting is a step even though there is no earlier step to move from.
 */
export class FlowDetector {
  private readonly options: DetectorOptions;
  private lastStep: CursorSample | null = null;
  /** Where the current rest began; moves along whenever the pointer leaves the rest radius. */
  private anchor: CursorSample | null = null;
  private paused = false;

  constructor(options: Partial<DetectorOptions> = {}) {
    this.options = { ...DEFAULT_DETECTOR_OPTIONS, ...options };
  }

  feed(sample: CursorSample): CursorSample | null {
    if (this.paused) return null;
    const { restRadius, dwellMs, moveThreshold, minIntervalMs } = this.options;
    if (!this.anchor || distance(sample, this.anchor) > restRadius) {
      this.anchor = sample;
      return null;
    }
    if (sample.t - this.anchor.t < dwellMs) return null;
    const last = this.lastStep;
    if (last && distance(this.anchor, last) <= moveThreshold) return null;
    if (last && sample.t - last.t < minIntervalMs) return null;
    this.lastStep = sample;
    return sample;
  }

  /** A step the person asked for: automatic detection does not repeat it while the pointer stays. */
  noteManual(sample: CursorSample): void {
    this.lastStep = sample;
    this.anchor = sample;
  }

  /** While paused no sample is looked at; resuming starts a fresh rest (the last step is kept). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.anchor = null;
  }

  reset(): void {
    this.lastStep = null;
    this.anchor = null;
    this.paused = false;
  }
}
