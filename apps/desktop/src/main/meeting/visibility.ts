import { isMeetingStillShown, type MeetingApp } from '../../shared/meeting-signatures';
import type { PanelPlaceholder } from '../../shared/panels';
import type { WinInfo, WindowProbe } from '../platform/window-probe';

export type MeetingVisibility = 'visible' | 'hidden' | 'ended';

/** How often a meeting window is looked at while a recording shows it. */
export const WATCH_POLL_MS = 500;
/** Readings in a row that must say "hidden" before the picture is replaced by a card. */
const HIDE_AFTER_READINGS = 2;

/**
 * Whether a meeting window is in the picture. `ended`: the meeting is over or its window is gone.
 * `hidden`: minimized, cloaked (another virtual desktop), or (a Meet call) no longer the browser's
 * active tab. A window covered by other windows is `visible`: Windows Graphics Capture records it.
 */
export function visibilityOf(
  app: MeetingApp,
  info: WinInfo | null,
  meetingEnded: boolean,
): MeetingVisibility {
  if (meetingEnded || info === null) return 'ended';
  if (info.minimized || info.cloaked || !isMeetingStillShown(app, info)) return 'hidden';
  return 'visible';
}

/** One meeting window in a recording: slot 0 is the recording itself, 1..3 are panels. */
export interface PanelBinding {
  sessionId: string;
  /** Null until the panel exists (the window was minimized when the recording started). */
  slot: number | null;
  meetingId: string;
  app: MeetingApp;
  hwnd: string;
  /** Adds the panel once the window is visible; returns its slot. Only for a binding without a slot. */
  attach?: () => Promise<number>;
}

export interface PanelWatcherDeps {
  probe: Pick<WindowProbe, 'get'>;
  /** Hides or shows a picture. Throws when the recording or the panel is gone (the binding then stops). */
  setPanelHidden(
    sessionId: string,
    slot: number,
    hidden: boolean,
    placeholder: PanelPlaceholder,
  ): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  pollMs?: number;
  /** A binding's state changed (also when it is first bound). */
  onChange?(binding: Readonly<PanelBinding>, state: MeetingVisibility): void;
  log?(message: string): void;
}

interface Watched {
  binding: PanelBinding;
  state: MeetingVisibility;
  /** Consecutive readings that said `hidden` while the state was still `visible`. */
  hiddenStreak: number;
  attaching: boolean;
}

/**
 * Looks at the meeting windows a recording shows, twice a second, and puts a neutral card over a
 * window while it is hidden. Electron-free: the probe, the timer and the recorder are injected.
 * Hiding needs two readings in a row (a window animating open or closed flickers); showing again
 * is immediate. An ended meeting stays ended.
 */
export class MeetingPanelWatcher {
  private readonly watched = new Set<Watched>();
  private readonly endedMeetings = new Set<string>();
  private timer: unknown;
  private polling = false;

  constructor(private readonly deps: PanelWatcherDeps) {}

  /** Starts watching a window. It is taken as visible (or as `initial`) until a reading says otherwise. */
  bind(binding: PanelBinding, initial: 'visible' | 'hidden' = 'visible'): void {
    const entry: Watched = {
      binding: { ...binding },
      state: this.endedMeetings.has(binding.meetingId) ? 'ended' : initial,
      hiddenStreak: 0,
      attaching: false,
    };
    this.watched.add(entry);
    this.deps.onChange?.(entry.binding, entry.state);
    this.ensureTimer();
  }

  /** Stops watching one picture of a recording (its panel was removed). */
  unbind(sessionId: string, slot: number): void {
    for (const entry of this.watched) {
      if (entry.binding.sessionId === sessionId && entry.binding.slot === slot) {
        this.watched.delete(entry);
      }
    }
    this.stopTimerIfIdle();
  }

  /** Stops watching everything of a recording (it ended). */
  endSession(sessionId: string): void {
    for (const entry of this.watched) {
      if (entry.binding.sessionId === sessionId) this.watched.delete(entry);
    }
    this.stopTimerIfIdle();
  }

  /** The detector says the meeting is over: its pictures show the "Meeting ended" card. */
  markMeetingEnded(meetingId: string): void {
    this.endedMeetings.add(meetingId);
    for (const entry of this.watched) {
      if (entry.binding.meetingId === meetingId) this.apply(entry, 'ended');
    }
  }

  stateOf(sessionId: string, slot: number): MeetingVisibility | undefined {
    for (const entry of this.watched) {
      if (entry.binding.sessionId === sessionId && entry.binding.slot === slot) return entry.state;
    }
    return undefined;
  }

  get size(): number {
    return this.watched.size;
  }

  dispose(): void {
    this.watched.clear();
    this.stopTimerIfIdle();
  }

  /** One round of readings (the timer calls it; tests call it directly). */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const entry of [...this.watched]) {
        if (!this.watched.has(entry)) continue;
        await this.read(entry);
      }
    } finally {
      this.polling = false;
    }
  }

  private async read(entry: Watched): Promise<void> {
    const { binding } = entry;
    if (entry.state === 'ended') return;
    let info: WinInfo | null;
    try {
      info = await this.deps.probe.get(binding.hwnd);
    } catch {
      return; // a failed reading changes nothing
    }
    if (!this.watched.has(entry)) return;
    const reading = visibilityOf(binding.app, info, this.endedMeetings.has(binding.meetingId));
    if (reading === 'hidden') {
      entry.hiddenStreak += 1;
      if (entry.hiddenStreak >= HIDE_AFTER_READINGS) this.apply(entry, 'hidden');
      return;
    }
    entry.hiddenStreak = 0;
    if (reading === 'visible' && binding.slot === null) await this.attach(entry);
    else this.apply(entry, reading);
  }

  /** The window became visible: the panel the recording could not take earlier is added now. */
  private async attach(entry: Watched): Promise<void> {
    const { binding } = entry;
    if (entry.attaching || !binding.attach) return;
    entry.attaching = true;
    try {
      binding.slot = await binding.attach();
      this.apply(entry, 'visible');
    } catch (error) {
      this.deps.log?.(
        `meeting panel not added: ${error instanceof Error ? error.message : 'error'}`,
      );
    } finally {
      entry.attaching = false;
    }
  }

  private apply(entry: Watched, next: MeetingVisibility): void {
    // An ended meeting stays ended (a reading that was in flight when it ended must not undo it).
    if (entry.state === next || entry.state === 'ended') return;
    const { binding } = entry;
    entry.state = next;
    entry.hiddenStreak = 0;
    if (binding.slot !== null) {
      try {
        this.deps.setPanelHidden(
          binding.sessionId,
          binding.slot,
          next !== 'visible',
          next === 'ended' ? 'meeting-ended' : 'meeting-hidden',
        );
      } catch {
        // The recording ended or the panel was taken out: nothing left to watch.
        this.watched.delete(entry);
        this.stopTimerIfIdle();
        return;
      }
    }
    this.deps.onChange?.(binding, next);
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = this.deps.setInterval(() => void this.poll(), this.deps.pollMs ?? WATCH_POLL_MS);
  }

  private stopTimerIfIdle(): void {
    if (this.watched.size > 0 || this.timer === undefined) return;
    this.deps.clearInterval(this.timer);
    this.timer = undefined;
  }
}
