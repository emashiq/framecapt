import { cursorToFramePixels, MAX_FLOW_STEPS } from '../../shared/flow';
import type { StepsSnapshot } from '../../shared/flow-ipc';
import { displayForPoint, type DisplayGeom, type Point } from '../../shared/geometry';
import type { DisplayInfo } from '../capture/types';
import { IpcError } from '../ipc-core';
import { FlowDetector } from './flow-detector';
import type { GuideStep } from './flow-store';

/** How often the pointer is read while steps are captured. Idle costs nothing: no timer runs. */
export const POLL_INTERVAL_MS = 100;
/** The pill follows the pointer to another display at most this often (ms). */
export const FOLLOW_THROTTLE_MS = 400;

type StepsState = StepsSnapshot['state'];

/** What the controller needs from the app (Electron-free so the whole thing is unit tested). */
export interface StepsDeps {
  /** Wall clock (epoch ms) for `at` and `createdAt`. */
  now: () => number;
  /** Monotonic ms for the detector. */
  monotonic: () => number;
  cursor: () => Point;
  displays: () => DisplayInfo[];
  /** A pixel-exact image of one display, without the pointer. */
  grab: (display: DisplayInfo) => Promise<{ width: number; height: number; png: Uint8Array }>;
  sessions: {
    begin: () => Promise<{ id: string; dir: string }>;
    writeStep: (dir: string, index: number, png: Uint8Array) => Promise<string>;
    discard: (dir: string) => Promise<void>;
  };
  /** Writes the guide folder and adds it to History. */
  save: (input: { steps: GuideStep[]; createdAt: number }) => Promise<{ historyId: string }>;
  /** A recording or a screenshot flow runs: steps cannot start. */
  isBlocked: () => boolean;
  /** True while the pointer is over the Steps pill (its own place is never a step). */
  isOverPill?: (point: Point) => boolean;
  /** Shows the pill and gets the main window out of the way / puts both back. */
  ui: {
    open: () => void;
    close: () => void;
    /** The pointer is on another display: move the pill there. */
    follow?: (displayId: string) => void;
  };
  log?: { info: (message: string) => void; warn: (message: string) => void };
  intervalMs?: number;
  maxSteps?: number;
}

/** The display whose bounds are closest to a point that lies in none of them (DIP). */
function nearestDisplay(point: Point, displays: readonly DisplayInfo[]): DisplayInfo | undefined {
  let best: DisplayInfo | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    const dx = Math.max(x - point.x, 0, point.x - (x + width));
    const dy = Math.max(y - point.y, 0, point.y - (y + height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}

const toGeom = (display: DisplayInfo): DisplayGeom => ({
  id: display.id,
  bounds: display.bounds,
  scaleFactor: display.scaleFactor,
  rotation: display.rotation,
});

/**
 * The step-capture session. States: idle, active, paused, saving. While active the pointer is read
 * every 100 ms and fed to the FlowDetector (no global input hooks); a step grabs the display under
 * the pointer, stores the PNG in the session folder and remembers where the pointer was in that
 * image. Every command is idempotent or refused with a typed error; every path ends in idle with
 * the session folder gone (a saved guide lives in the screenshots folder).
 */
export class StepsController {
  private state: StepsState = 'idle';
  private auto = true;
  private notice: string | null = null;
  private session: { id: string; dir: string } | null = null;
  private steps: GuideStep[] = [];
  private startedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly detector = new FlowDetector();
  /** Grabs run one after another; an automatic step is skipped while one is already queued. */
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastOutside: Point | null = null;
  /** The display the pill was last placed on, and when (monotonic ms). */
  private pillDisplay: string | null = null;
  private pillMovedAt = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<(snapshot: StepsSnapshot) => void>();
  private readonly max: number;

  constructor(private readonly deps: StepsDeps) {
    this.max = deps.maxSteps ?? MAX_FLOW_STEPS;
  }

  get status(): StepsState {
    return this.state;
  }

  /** A guide is being captured (also while it is paused or saved). */
  get active(): boolean {
    return this.state !== 'idle';
  }

  snapshot(): StepsSnapshot {
    return {
      state: this.state,
      auto: this.auto,
      count: this.steps.length,
      max: this.max,
      notice: this.notice,
    };
  }

  onChange(listener: (snapshot: StepsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private setNotice(text: string | null): void {
    this.notice = text;
    this.emit();
  }

  // --- commands ----------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.state !== 'idle') throw new IpcError('BUSY', 'Step capture is already running.');
    if (this.deps.isBlocked()) {
      throw new IpcError('BUSY', 'Finish the recording or screenshot in progress first.');
    }
    // Claim the state before the first await, so two starts cannot both pass.
    this.state = 'active';
    try {
      this.session = await this.deps.sessions.begin();
    } catch (error) {
      this.state = 'idle';
      throw error;
    }
    this.steps = [];
    this.notice = null;
    this.auto = true;
    this.lastOutside = null;
    this.startedAt = this.deps.now();
    this.detector.reset();
    const origin = this.deps.cursor();
    // The pill opens on the pointer's display; it only moves when the pointer leaves it.
    this.pillDisplay = this.displayAt(origin)?.id ?? null;
    this.pillMovedAt = Number.NEGATIVE_INFINITY;
    this.detector.start({ ...origin, t: this.deps.monotonic(), ...this.displayTag(origin) });
    this.deps.log?.info('Step capture started');
    this.startTimer();
    this.deps.ui.open();
    this.emit();
  }

  pause(): void {
    if (this.state !== 'active') return;
    this.state = 'paused';
    this.syncDetector();
    this.emit();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    if (this.steps.length >= this.max) return;
    this.state = 'active';
    this.notice = null;
    this.syncDetector();
    this.emit();
  }

  setAuto(auto: boolean): void {
    if (this.state === 'idle' || this.state === 'saving' || auto === this.auto) return;
    this.auto = auto;
    this.syncDetector();
    this.emit();
  }

  /** A step now, at the pointer (or where it last was outside the pill). */
  async captureStep(): Promise<void> {
    if (this.state !== 'active' && this.state !== 'paused') return;
    const now = this.deps.cursor();
    const over = this.deps.isOverPill?.(now) ?? false;
    const point = over ? this.lastOutside : now;
    await this.enqueue(point, true);
  }

  /** Saves the guide. With no step there is nothing to save: the session is discarded. */
  async done(): Promise<{ historyId: string } | { discarded: true }> {
    if (this.state !== 'active' && this.state !== 'paused') {
      throw new IpcError('NOT_FOUND', 'There is no step capture to finish.');
    }
    this.state = 'saving';
    this.stopTimer();
    this.emit();
    await this.chain;
    const session = this.session;
    if (!session || this.steps.length === 0) {
      await this.finish();
      return { discarded: true };
    }
    try {
      const saved = await this.deps.save({ steps: [...this.steps], createdAt: this.startedAt });
      this.deps.log?.info(`Step capture finished: ${this.steps.length} steps`);
      await this.finish();
      return saved;
    } catch (error) {
      this.deps.log?.warn(`The guide could not be saved: ${(error as Error).message}`);
      // Everything captured is still in the session folder: the person can try again.
      this.state = 'paused';
      this.notice = 'The guide could not be saved. Try Done again.';
      this.syncDetector();
      this.emit();
      throw error instanceof IpcError
        ? error
        : new IpcError('INTERNAL', 'The guide could not be saved. Try again.');
    }
  }

  /** Throws the steps away. */
  async cancel(): Promise<void> {
    if (this.state === 'idle' || this.state === 'saving') return;
    this.state = 'saving';
    this.stopTimer();
    await this.chain;
    this.deps.log?.info('Step capture cancelled');
    await this.finish();
  }

  /** The app is quitting: the session folder goes, nothing is saved. */
  async dispose(): Promise<void> {
    this.stopTimer();
    if (this.session) await this.deps.sessions.discard(this.session.dir);
    this.session = null;
  }

  private async finish(): Promise<void> {
    this.stopTimer();
    const session = this.session;
    this.session = null;
    this.steps = [];
    this.notice = null;
    this.state = 'idle';
    this.detector.reset();
    this.deps.ui.close();
    this.emit();
    if (session) await this.deps.sessions.discard(session.dir);
  }

  // --- polling and capturing -----------------------------------------------------------------

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs ?? POLL_INTERVAL_MS);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private syncDetector(): void {
    this.detector.setPaused(this.state !== 'active' || !this.auto);
  }

  /** One poll: the pointer is read, fed to the detector, and a step is taken when it rested. */
  tick(): void {
    if (this.state !== 'active' && this.state !== 'paused') return;
    const point = this.deps.cursor();
    if (this.deps.isOverPill?.(point)) return;
    this.lastOutside = point;
    this.followPointer(point);
    if (this.state !== 'active' || !this.auto) return;
    const hit = this.detector.feed({
      ...point,
      t: this.deps.monotonic(),
      ...this.displayTag(point),
    });
    if (hit && this.queued === 0) void this.enqueue(point, false);
  }

  /** The display under a global DIP point (the nearest one when it lies between displays). */
  private displayAt(point: Point): DisplayInfo | undefined {
    const displays = this.deps.displays();
    const geom = displayForPoint(point, displays.map(toGeom));
    return (
      displays.find((candidate) => candidate.id === geom?.id) ??
      nearestDisplay(point, displays) ??
      displays.find((candidate) => candidate.isPrimary) ??
      displays[0]
    );
  }

  private displayTag(point: Point): { display?: string } {
    const id = this.displayAt(point)?.id;
    return id === undefined ? {} : { display: id };
  }

  /** Moves the pill to the pointer's display: only when that changed, and not faster than the throttle. */
  private followPointer(point: Point): void {
    if (!this.deps.ui.follow) return;
    const id = this.displayAt(point)?.id;
    if (id === undefined || id === this.pillDisplay) return;
    const now = this.deps.monotonic();
    if (now - this.pillMovedAt < FOLLOW_THROTTLE_MS) return;
    this.pillDisplay = id;
    this.pillMovedAt = now;
    this.deps.ui.follow(id);
  }

  private enqueue(point: Point | null, manual: boolean): Promise<void> {
    this.queued += 1;
    const task = this.chain.then(() => this.capture(point, manual));
    this.chain = task.catch(() => undefined);
    return task.finally(() => {
      this.queued -= 1;
    });
  }

  private async capture(point: Point | null, manual: boolean): Promise<void> {
    const session = this.session;
    if (!session || (this.state !== 'active' && !(manual && this.state === 'paused'))) return;
    if (this.steps.length >= this.max) {
      this.limitReached();
      return;
    }
    try {
      const displays = this.deps.displays();
      const display = point
        ? this.displayAt(point)
        : (displays.find((candidate) => candidate.isPrimary) ?? displays[0]);
      if (!display) throw new Error('No display.');
      const frame = await this.deps.grab(display);
      // Cancelled or finished while the screen was being grabbed: nothing to keep.
      if (this.session !== session || (this.state !== 'active' && this.state !== 'paused')) return;
      const index = this.steps.length;
      const source = await this.deps.sessions.writeStep(session.dir, index, frame.png);
      if (this.session !== session) return;
      this.steps.push({
        source,
        width: frame.width,
        height: frame.height,
        cursor: point ? cursorToFramePixels(point, toGeom(display), frame) : null,
        at: this.deps.now(),
      });
      if (point) {
        this.detector.noteManual({ ...point, t: this.deps.monotonic(), display: display.id });
      }
      if (this.steps.length >= this.max) this.limitReached();
      else this.emit();
    } catch (error) {
      this.deps.log?.warn(`A step could not be captured: ${(error as Error).message}`);
      // A failing disk or screen would fail every step: say so and wait for the person.
      if (this.state === 'active') {
        this.state = 'paused';
        this.syncDetector();
      }
      this.setNotice("A step couldn't be saved. Check the disk, then resume.");
    }
  }

  private limitReached(): void {
    if (this.state === 'active') {
      this.state = 'paused';
      this.syncDetector();
    }
    this.setNotice(`Step limit reached (${this.max}). Press Done to save your guide.`);
  }
}
