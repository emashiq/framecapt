import { randomUUID } from 'node:crypto';
import type { Rect } from '../../shared/rect';
import {
  isBrowserExe,
  matchMeetingWindow,
  matchShareIndicator,
  type MeetingApp,
} from '../../shared/meeting-signatures';
import type { Settings } from '../../shared/settings';
import { sourceIdFromHwnd, type WinInfo, type WindowProbe } from '../platform/window-probe';

/** How long a meeting window must match, in consecutive polls, before it counts as a meeting. */
const CONFIRM_POLLS = 2;
/** Misses in a row (with the window gone) after which a meeting ends at once. */
const GONE_MISSES = 2;
/** A meeting whose window still exists but no longer matches ends after this long. */
const GRACE_MS = 60_000;
/** A share indicator must be missing this many polls in a row before the share ends. */
const SHARE_END_MISSES = 2;
export const DEFAULT_POLL_MS = 2000;

export interface MeetingInfo {
  meetingId: string;
  app: MeetingApp;
  hwnd: string;
  /** desktopCapturer id of the meeting window. */
  sourceId: string;
  /** The window's rectangle when it was last seen (not minimized), for choosing a display. */
  displayBounds?: Rect;
  sharing: boolean;
}

export type MeetingDetectorEvent =
  | { type: 'meetingStarted'; meeting: MeetingInfo }
  | { type: 'meetingEnded'; meetingId: string }
  | { type: 'shareStarted'; meetingId: string; kind: 'screen' | 'window'; indicatorRect: Rect }
  | { type: 'shareEnded'; meetingId: string };

export interface DetectorDeps {
  probe: WindowProbe;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  settings(): Settings['meetings'];
  /** True while the app is quitting: polling stops. */
  isQuitting?(): boolean;
  intervalMs?: number;
  /** App ids and counts only: window titles are never logged. */
  log?(message: string): void;
}

interface Candidate {
  app: MeetingApp;
  hwnd: string;
  browser: boolean;
  streak: number;
  misses: number;
  lastMatchAt: number;
  meeting?: MeetingInfo;
  share?: { kind: 'screen' | 'window'; misses: number };
}

const keyOf = (app: MeetingApp, hwnd: string): string => `${app}:${hwnd}`;
const area = (rect: Rect): number => rect.width * rect.height;

/**
 * Watches the window list for meetings (Meet, Zoom, Teams, Webex) and for screen sharing inside
 * them. Electron-free: the probe, the clock and the timer are injected. A window must match in two
 * consecutive polls to count as a meeting; a meeting ends when its window is gone, or 60 s after it
 * last matched. Window titles are read in memory by the signatures and never stored or logged.
 */
export class MeetingDetector {
  private readonly candidates = new Map<string, Candidate>();
  /** When each Teams window was first seen matching (to pick the newest as the call window). */
  private readonly teamsSeen = new Map<string, number>();
  private readonly listeners = new Set<(event: MeetingDetectorEvent) => void>();
  private timer: unknown;
  private polling = false;

  constructor(private readonly deps: DetectorDeps) {}

  onEvent(listener: (event: MeetingDetectorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.deps.setInterval(
      () => void this.poll(),
      this.deps.intervalMs ?? DEFAULT_POLL_MS,
    );
    void this.poll();
  }

  /** Stops polling and ends every meeting (the events are emitted). */
  stop(): void {
    if (this.timer !== undefined) this.deps.clearInterval(this.timer);
    this.timer = undefined;
    this.stopCandidates();
  }

  /** Confirmed meetings. */
  current(): MeetingInfo[] {
    return [...this.candidates.values()].flatMap((c) => (c.meeting ? [{ ...c.meeting }] : []));
  }

  getWindow(hwnd: string): Promise<WinInfo | null> {
    return this.deps.probe.get(hwnd);
  }

  /** One look at the windows. Public so tests (and the E2E build) can drive it. */
  async poll(): Promise<void> {
    if (this.polling || this.deps.isQuitting?.() === true) return;
    this.polling = true;
    try {
      await this.scan();
    } catch (error) {
      this.deps.log?.(
        `meeting detection poll failed: ${error instanceof Error ? error.name : 'error'}`,
      );
    } finally {
      this.polling = false;
    }
  }

  private emit(event: MeetingDetectorEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async scan(): Promise<void> {
    const config = this.deps.settings();
    if (!config.detect) {
      this.stopCandidates();
      return;
    }
    const [windows, mic] = await Promise.all([
      this.deps.probe.list(),
      this.deps.probe.micInUse().catch(() => [] as string[]),
    ]);
    const now = this.deps.now();

    // Meeting windows of the enabled apps, by candidate key.
    const matched = new Map<string, WinInfo & { app: MeetingApp }>();
    for (const info of windows) {
      const match = matchMeetingWindow(info, mic);
      if (match && config.apps[match.app])
        matched.set(keyOf(match.app, info.hwnd), { ...info, app: match.app });
    }
    this.chooseOneTeamsWindow(matched, now);

    for (const [key, info] of matched) {
      let candidate = this.candidates.get(key);
      if (!candidate) {
        candidate = {
          app: info.app,
          hwnd: info.hwnd,
          browser: info.app === 'meet' || isBrowserExe(info.exe),
          streak: 0,
          misses: 0,
          lastMatchAt: now,
        };
        this.candidates.set(key, candidate);
      }
      candidate.streak += 1;
      candidate.misses = 0;
      candidate.lastMatchAt = now;
      if (candidate.meeting) {
        if (!info.minimized) candidate.meeting.displayBounds = { ...info.rect };
      } else if (candidate.streak >= CONFIRM_POLLS) {
        candidate.meeting = {
          meetingId: randomUUID(),
          app: candidate.app,
          hwnd: candidate.hwnd,
          sourceId: sourceIdFromHwnd(candidate.hwnd),
          ...(!info.minimized && { displayBounds: { ...info.rect } }),
          sharing: false,
        };
        this.deps.log?.(`meeting detected: ${candidate.app}`);
        this.emit({ type: 'meetingStarted', meeting: { ...candidate.meeting } });
      }
    }

    for (const [key, candidate] of this.candidates) {
      if (matched.has(key)) continue;
      if (!candidate.meeting || !config.apps[candidate.app]) {
        // Not confirmed yet (the streak must be consecutive), or the app was switched off.
        this.drop(key, candidate);
        continue;
      }
      candidate.misses += 1;
      const expired = now - candidate.lastMatchAt >= GRACE_MS;
      if (
        expired ||
        (candidate.misses >= GONE_MISSES && (await this.deps.probe.get(candidate.hwnd)) === null)
      ) {
        this.drop(key, candidate);
      }
    }

    this.updateShares(windows);
  }

  /** Teams call windows have no fixed title: keep the tracked one, else the newest (then the largest). */
  private chooseOneTeamsWindow(
    matched: Map<string, WinInfo & { app: MeetingApp }>,
    now: number,
  ): void {
    const teams = [...matched.entries()].filter(([, info]) => info.app === 'teams');
    for (const key of [...this.teamsSeen.keys()]) {
      if (!matched.has(key)) this.teamsSeen.delete(key);
    }
    if (teams.length === 0) return;
    for (const [key] of teams) if (!this.teamsSeen.has(key)) this.teamsSeen.set(key, now);
    const tracked = teams.find(([key]) => this.candidates.get(key)?.meeting);
    const best =
      tracked ??
      [...teams].sort(
        (a, b) =>
          (this.teamsSeen.get(b[0]) ?? 0) - (this.teamsSeen.get(a[0]) ?? 0) ||
          area(b[1].rect) - area(a[1].rect),
      )[0];
    for (const [key] of teams) if (key !== best?.[0]) matched.delete(key);
  }

  private updateShares(windows: readonly WinInfo[]): void {
    const seen = new Map<Candidate, { kind: 'screen' | 'window'; rect: Rect }>();
    for (const info of windows) {
      const indicator = matchShareIndicator(info);
      if (!indicator) continue;
      const target = this.shareTarget(indicator.app);
      if (target && !seen.has(target))
        seen.set(target, { kind: indicator.kind, rect: { ...info.rect } });
    }
    for (const candidate of this.candidates.values()) {
      const meeting = candidate.meeting;
      if (!meeting) continue;
      const hit = seen.get(candidate);
      if (hit) {
        if (!candidate.share) {
          candidate.share = { kind: hit.kind, misses: 0 };
          meeting.sharing = true;
          this.emit({
            type: 'shareStarted',
            meetingId: meeting.meetingId,
            kind: hit.kind,
            indicatorRect: hit.rect,
          });
        } else {
          candidate.share.misses = 0;
        }
      } else if (candidate.share) {
        candidate.share.misses += 1;
        if (candidate.share.misses >= SHARE_END_MISSES) this.endShare(candidate);
      }
    }
  }

  /** The confirmed meeting an indicator belongs to. A browser's own indicator does not name the site. */
  private shareTarget(app: MeetingApp | 'browser'): Candidate | undefined {
    const confirmed = [...this.candidates.values()].filter((c) => c.meeting);
    if (app !== 'browser') return confirmed.find((c) => c.app === app);
    const inBrowser = confirmed.filter((c) => c.browser);
    return (
      inBrowser.find((c) => c.app === 'meet') ??
      inBrowser[0] ??
      (confirmed.length === 1 ? confirmed[0] : undefined)
    );
  }

  private endShare(candidate: Candidate): void {
    if (!candidate.share || !candidate.meeting) return;
    candidate.share = undefined;
    candidate.meeting.sharing = false;
    this.emit({ type: 'shareEnded', meetingId: candidate.meeting.meetingId });
  }

  /** Removes a candidate; a confirmed meeting ends (after its share). */
  private drop(key: string, candidate: Candidate): void {
    this.candidates.delete(key);
    if (!candidate.meeting) return;
    this.endShare(candidate);
    this.deps.log?.(`meeting ended: ${candidate.app}`);
    this.emit({ type: 'meetingEnded', meetingId: candidate.meeting.meetingId });
  }

  private stopCandidates(): void {
    for (const [key, candidate] of this.candidates) this.drop(key, candidate);
    this.teamsSeen.clear();
  }
}
