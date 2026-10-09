import { friendlyError } from '../../shared/error-messages';
import { MEETING_APP_LABELS, type MeetingApp } from '../../shared/meeting-signatures';
import type { PanelKind, PanelPlaceholder, PanelSlot } from '../../shared/panels';
import type {
  RecordOptions,
  RecorderSessionSummary,
  RecorderStartRequest,
  SessionMeeting,
} from '../../shared/recorder-ipc';
import { isPreRecording } from '../../shared/recorder-machine';
import { isLiveStatus, primaryOf } from '../../shared/recorder-sessions';
import type { Rect } from '../../shared/rect';
import { recordOptionsFromSettings, type Settings } from '../../shared/settings';
import type { DisplayInfo } from '../capture/types';
import { IpcError } from '../ipc-core';
import type { WinInfo } from '../platform/window-probe';
import type { MeetingInfo } from './detector';
import type { MeetingActions } from './service';
import { MeetingPanelWatcher, visibilityOf, type MeetingVisibility } from './visibility';

/** The recorder as the meeting code uses it (the RecorderController satisfies it). */
export interface MeetingRecorderPort {
  start(request: RecorderStartRequest): Promise<{ sessionId: string }>;
  sessions(): RecorderSessionSummary[];
  onChange(listener: () => void): () => void;
  panelState(
    sessionId: string | undefined,
  ): { sessionId: string; panels: PanelSlot[]; addDisabled: boolean } | undefined;
  addPanelSource(sessionId: string, source: { kind: PanelKind; sourceId: string }): Promise<number>;
  addPanel(request: {
    sessionId: string;
    kind: 'screen';
    displayId: string;
  }): Promise<{ slot: number }>;
  removePanel(sessionId: string, slot: number): void;
  setPanelHidden(
    sessionId: string,
    slot: number,
    hidden: boolean,
    placeholder: PanelPlaceholder,
  ): void;
  setSessionMeeting(sessionId: string, meeting: SessionMeeting | null): void;
  /** The displays a recording shows whole (its own screen and its screen panels). */
  shownDisplayIds(sessionId: string): string[];
}

/** The meeting service as the meeting recorder uses it. */
export interface MeetingSource {
  find(meetingId: string): MeetingInfo | undefined;
  getWindow(hwnd: string): Promise<WinInfo | null>;
  onShareStarted(
    listener: (meetingId: string, kind: 'screen' | 'window', indicatorRect: Rect) => void,
  ): () => void;
  onShareEnded(listener: (meetingId: string) => void): () => void;
  onMeetingEnded(listener: (meetingId: string) => void): () => void;
}

export interface MeetingRecorderDeps {
  recorder: MeetingRecorderPort;
  meetings: MeetingSource;
  settings(): Settings;
  displays(): DisplayInfo[];
  /** The display the mouse is on (its id as the capture provider lists it), if known. */
  cursorDisplayId(): string | undefined;
  /** Tells the user something (the main window, else a recording's toolbar, else a notification). */
  toast(message: string): void;
  /** An OS notification (the caller applies the "show notifications" setting). */
  notify(title: string, body: string): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Overrides the 500 ms look at the meeting windows (E2E builds only). */
  pollMs?: number;
  log(message: string): void;
}

/** A message for the user, shown as it is. */
class MeetingNotice extends Error {}

export const NO_PANEL_MESSAGE = "This recording can't take another panel.";
export const bringToFrontMessage = (label: string): string =>
  `Bring the ${label} window to the front, then try again.`;

/** A recording waits this long for the user (a microphone question, say) before the meeting window is added. */
const LIVE_WAIT_MS = 120_000;
/** "Your shared screen is already in the recording" goes away by itself. */
const ALREADY_BANNER_MS = 5000;

/** One meeting in one recording. */
interface Tracked {
  sessionId: string;
  meetingId: string;
  app: MeetingApp;
  /** Null until the panel exists (the window was minimized when the recording started). */
  slot: number | null;
  state: MeetingVisibility;
  sharing: boolean;
  banner: 'share-ask' | 'share-already' | null;
  bannerTimer: ReturnType<typeof setTimeout> | undefined;
  /** The recording's panels when the question was asked: adding one answers it. */
  panelsAtAsk: number;
  /** The screen panel main added for the share (taken out when the share ends). */
  sharePanel: number | null;
}

function physicalRect(display: DisplayInfo): Rect {
  return {
    x: Math.round(display.bounds.x * display.scaleFactor),
    y: Math.round(display.bounds.y * display.scaleFactor),
    ...display.physicalSize,
  };
}

/**
 * Meeting recording: starts a recording of a meeting window (alone or beside the user's screen),
 * adds a meeting to a running recording, hides a meeting's picture while its window is hidden,
 * and adds the screen the user shares in the meeting. It is the real `MeetingActions` of the
 * prompt, the main window's chip and the tray. Electron-free: the recorder, the meeting service and
 * the displays are injected.
 */
export class MeetingRecorder implements MeetingActions {
  private readonly tracked: Tracked[] = [];
  private readonly watcher: MeetingPanelWatcher;
  private readonly published = new Map<string, string>();
  /** Recordings whose first hidden meeting window was already announced by a notification. */
  private readonly notified = new Set<string>();
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly deps: MeetingRecorderDeps) {
    this.watcher = new MeetingPanelWatcher({
      probe: { get: (hwnd) => deps.meetings.getWindow(hwnd) },
      setPanelHidden: (...args) => deps.recorder.setPanelHidden(...args),
      setInterval: deps.setInterval,
      clearInterval: deps.clearInterval,
      ...(deps.pollMs !== undefined && { pollMs: deps.pollMs }),
      onChange: (binding, state) =>
        this.onWatch(binding.sessionId, binding.meetingId, binding.slot, state),
      log: deps.log,
    });
    this.unsubscribe = [
      deps.meetings.onShareStarted((meetingId, kind, rect) =>
        this.onShareStarted(meetingId, kind, rect),
      ),
      deps.meetings.onShareEnded((meetingId) => this.onShareEnded(meetingId)),
      deps.meetings.onMeetingEnded((meetingId) => this.watcher.markMeetingEnded(meetingId)),
      deps.recorder.onChange(() => this.sync()),
    ];
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.watcher.dispose();
    for (const entry of this.tracked) clearTimeout(entry.bannerTimer);
    this.tracked.length = 0;
  }

  // --- starting ----------------------------------------------------------------------------

  async startMeetingRecording(
    meeting: MeetingInfo,
    options: { withScreen: boolean; displayId?: string },
  ): Promise<void> {
    try {
      await this.begin(meeting, options);
    } catch (error) {
      this.deps.toast(this.messageOf(error));
    }
  }

  /** `meeting:record` from the main window. */
  async recordById(meetingId: string, withScreen: boolean, displayId?: string): Promise<void> {
    const meeting = this.deps.meetings.find(meetingId);
    if (!meeting) throw new IpcError('NOT_FOUND', 'That meeting is no longer available.');
    await this.startMeetingRecording(meeting, { withScreen, ...(displayId && { displayId }) });
  }

  /** `recorder:start` with the target `meeting`: a displayId asks for the user's screen as well. */
  async startFromRequest(request: RecorderStartRequest): Promise<{ sessionId: string }> {
    const meeting = request.meeting && this.deps.meetings.find(request.meeting.meetingId);
    if (!meeting) throw new IpcError('NOT_FOUND', 'That meeting is no longer available.');
    try {
      return await this.begin(meeting, {
        withScreen: request.displayId !== undefined,
        ...(request.displayId && { displayId: request.displayId }),
      });
    } catch (error) {
      if (error instanceof MeetingNotice) throw new IpcError('NOT_FOUND', error.message);
      throw error;
    }
  }

  private messageOf(error: unknown): string {
    if (error instanceof MeetingNotice) return error.message;
    const failure = error as { code?: string; message?: string };
    return friendlyError(failure.code, failure.message);
  }

  /** What a meeting recording records: the user's settings, with the audio of a call. */
  private meetingOptions(): RecordOptions {
    const base = recordOptionsFromSettings(this.deps.settings().recording);
    return {
      ...base,
      // The microphone (the user's chosen one, else the default), and the call's sound from the PC.
      mic: {
        enabled: true,
        ...(base.mic.deviceId !== undefined && { deviceId: base.mic.deviceId }),
      },
      systemAudio: true,
      // The meeting is already going on.
      countdown: false,
    };
  }

  /** The screen for "+ my screen": the one asked for, else the one under the mouse, else the primary. */
  private screenFor(displayId: string | undefined): string {
    const displays = this.deps.displays();
    const wanted = [displayId, this.deps.cursorDisplayId()];
    for (const id of wanted) {
      if (id !== undefined && displays.some((display) => display.id === id)) return id;
    }
    const fallback = displays.find((display) => display.isPrimary) ?? displays[0];
    if (!fallback) throw new MeetingNotice('No screen was found to record.');
    return fallback.id;
  }

  private async begin(
    meeting: MeetingInfo,
    options: { withScreen: boolean; displayId?: string },
  ): Promise<{ sessionId: string }> {
    const label = MEETING_APP_LABELS[meeting.app];
    const info = await this.deps.meetings.getWindow(meeting.hwnd);
    const visibility = visibilityOf(meeting.app, info, false);
    if (visibility === 'ended')
      throw new MeetingNotice(`The ${label} window is no longer available.`);
    // Windows Graphics Capture fails for good when the first frame never arrives: a minimized
    // window cannot be the recording. Beside a screen it can wait until the window is shown.
    if (visibility === 'hidden' && !options.withScreen) {
      throw new MeetingNotice(bringToFrontMessage(label));
    }
    const recordOptions = this.meetingOptions();
    const request: RecorderStartRequest = options.withScreen
      ? { target: 'screen', displayId: this.screenFor(options.displayId), options: recordOptions }
      : { target: 'window', sourceId: meeting.sourceId, options: recordOptions };
    const { sessionId } = await this.deps.recorder.start(request);
    this.track(sessionId, meeting, options.withScreen ? null : 0, visibility);
    void this.bindWhenLive(sessionId, meeting, options.withScreen, visibility === 'hidden');
    return { sessionId };
  }

  /** Once the recording runs: the watcher takes over (and, beside a screen, the window is added). */
  private async bindWhenLive(
    sessionId: string,
    meeting: MeetingInfo,
    withScreen: boolean,
    hiddenAtStart: boolean,
  ): Promise<void> {
    const binding = {
      sessionId,
      meetingId: meeting.meetingId,
      app: meeting.app,
      hwnd: meeting.hwnd,
    };
    try {
      if (!(await this.waitLive(sessionId))) return;
      if (!withScreen) return this.watcher.bind({ ...binding, slot: 0 });
      const attach = (): Promise<number> =>
        this.deps.recorder.addPanelSource(sessionId, {
          kind: 'window',
          sourceId: meeting.sourceId,
        });
      if (hiddenAtStart) return this.watcher.bind({ ...binding, slot: null, attach }, 'hidden');
      this.watcher.bind({ ...binding, slot: await attach() });
    } catch (error) {
      this.deps.log(
        `meeting window not added: ${error instanceof Error ? error.message : 'error'}`,
      );
      this.deps.toast(
        `Couldn't add the ${MEETING_APP_LABELS[meeting.app]} window to the recording.`,
      );
      this.untrack(sessionId, meeting.meetingId);
    }
  }

  /** Resolves true once the recording is live, false when it ended (or never got there). */
  private waitLive(sessionId: string): Promise<boolean> {
    return new Promise((resolve) => {
      let off: () => void = () => undefined;
      const settle = (live: boolean): boolean => {
        off();
        clearTimeout(timer);
        resolve(live);
        return true;
      };
      const check = (): boolean => {
        const session = this.deps.recorder.sessions().find((s) => s.sessionId === sessionId);
        if (session && isLiveStatus(session.status)) return settle(true);
        if (!session || !isPreRecording(session.status)) return settle(false);
        return false;
      };
      const timer = setTimeout(() => settle(false), LIVE_WAIT_MS);
      if (check()) return;
      off = this.deps.recorder.onChange(check);
    });
  }

  // --- adding a meeting to a running recording -----------------------------------------------

  async addMeetingToRecording(meeting: MeetingInfo): Promise<void> {
    try {
      await this.addTo(meeting);
    } catch (error) {
      this.deps.toast(this.messageOf(error));
    }
  }

  /** `meeting:addToRecording` from the main window. */
  async addById(meetingId: string): Promise<void> {
    const meeting = this.deps.meetings.find(meetingId);
    if (!meeting) throw new IpcError('NOT_FOUND', 'That meeting is no longer available.');
    await this.addMeetingToRecording(meeting);
  }

  private async addTo(meeting: MeetingInfo): Promise<void> {
    const label = MEETING_APP_LABELS[meeting.app];
    const live = this.deps.recorder.sessions().filter((session) => isLiveStatus(session.status));
    const target = primaryOf(live);
    if (!target) throw new MeetingNotice('There is no recording to add to.');
    if (
      this.tracked.some(
        (t) => t.sessionId === target.sessionId && t.meetingId === meeting.meetingId,
      )
    ) {
      throw new MeetingNotice(`The ${label} meeting is already in the recording.`);
    }
    const state = this.deps.recorder.panelState(target.sessionId);
    if (!state || state.addDisabled || target.target === 'multi') {
      throw new MeetingNotice(NO_PANEL_MESSAGE);
    }
    const info = await this.deps.meetings.getWindow(meeting.hwnd);
    const visibility = visibilityOf(meeting.app, info, false);
    if (visibility === 'ended')
      throw new MeetingNotice(`The ${label} window is no longer available.`);
    if (visibility === 'hidden') throw new MeetingNotice(bringToFrontMessage(label));
    const slot = await this.deps.recorder.addPanelSource(target.sessionId, {
      kind: 'window',
      sourceId: meeting.sourceId,
    });
    this.track(target.sessionId, meeting, slot, 'visible');
    this.watcher.bind({
      sessionId: target.sessionId,
      slot,
      meetingId: meeting.meetingId,
      app: meeting.app,
      hwnd: meeting.hwnd,
    });
  }

  // --- what the toolbar shows ----------------------------------------------------------------

  private track(
    sessionId: string,
    meeting: MeetingInfo,
    slot: number | null,
    state: MeetingVisibility,
  ): void {
    this.tracked.push({
      sessionId,
      meetingId: meeting.meetingId,
      app: meeting.app,
      slot,
      state,
      sharing: meeting.sharing,
      banner: null,
      bannerTimer: undefined,
      panelsAtAsk: 0,
      sharePanel: null,
    });
    this.publish(sessionId);
  }

  private untrack(sessionId: string, meetingId: string): void {
    const index = this.tracked.findIndex(
      (entry) => entry.sessionId === sessionId && entry.meetingId === meetingId,
    );
    const [removed] = index < 0 ? [] : this.tracked.splice(index, 1);
    if (!removed) return;
    clearTimeout(removed.bannerTimer);
    if (removed.slot !== null) this.watcher.unbind(sessionId, removed.slot);
    this.publish(sessionId);
  }

  /** Tells the recording what to show: the picture that needs the user's attention first. */
  private publish(sessionId: string): void {
    const own = this.tracked.filter((entry) => entry.sessionId === sessionId);
    const lead = own.find((entry) => entry.state !== 'visible') ?? own[0];
    const meeting: SessionMeeting | null = lead
      ? {
          app: lead.app,
          appLabel: MEETING_APP_LABELS[lead.app],
          state: lead.state,
          sharing: own.some((entry) => entry.sharing),
          banner: own.find((entry) => entry.banner !== null)?.banner ?? null,
        }
      : null;
    // The recorder reports every change back to sync(): an unchanged state is not sent again.
    const text = JSON.stringify(meeting);
    if (this.published.get(sessionId) === text) return;
    if (meeting) this.published.set(sessionId, text);
    else this.published.delete(sessionId);
    this.deps.recorder.setSessionMeeting(sessionId, meeting);
  }

  private onWatch(
    sessionId: string,
    meetingId: string,
    slot: number | null,
    state: MeetingVisibility,
  ): void {
    const entry = this.find(sessionId, meetingId);
    if (!entry) return;
    entry.slot = slot;
    if (entry.state === state) return;
    entry.state = state;
    if (state === 'hidden') this.announceHidden(entry);
    this.publish(sessionId);
  }

  /** The first time a meeting window is hidden in a recording: a notification (the toolbar says it too). */
  private announceHidden(entry: Tracked): void {
    if (this.notified.has(entry.sessionId) || !this.deps.settings().general.showNotifications) {
      return;
    }
    this.notified.add(entry.sessionId);
    const label = MEETING_APP_LABELS[entry.app];
    this.deps.notify(
      'FrameCapt',
      `${label} window is hidden. Bring it to the front to keep capturing. Audio is still recording.`,
    );
  }

  private find(sessionId: string, meetingId: string): Tracked | undefined {
    return this.tracked.find((e) => e.sessionId === sessionId && e.meetingId === meetingId);
  }

  /** The recorder changed: forget recordings that ended and panels that were taken out. */
  private sync(): void {
    const sessions = this.deps.recorder.sessions();
    for (const entry of [...this.tracked]) {
      const session = sessions.find((candidate) => candidate.sessionId === entry.sessionId);
      const running =
        session !== undefined && (isLiveStatus(session.status) || isPreRecording(session.status));
      if (!running) {
        this.endRecording(entry.sessionId);
        continue;
      }
      if (!isLiveStatus(session.status)) continue;
      const panels = this.deps.recorder.panelState(entry.sessionId)?.panels ?? [];
      if (
        entry.slot !== null &&
        entry.slot > 0 &&
        !panels.some((panel) => panel.slot === entry.slot)
      ) {
        this.untrack(entry.sessionId, entry.meetingId);
        continue;
      }
      if (entry.sharePanel !== null && !panels.some((panel) => panel.slot === entry.sharePanel)) {
        entry.sharePanel = null;
      }
      // A panel the user added answers "add it to the recording?".
      if (entry.banner === 'share-ask' && session.panels > entry.panelsAtAsk) {
        this.setBanner(entry, null);
      }
    }
  }

  private endRecording(sessionId: string): void {
    this.watcher.endSession(sessionId);
    for (let i = this.tracked.length - 1; i >= 0; i -= 1) {
      const entry = this.tracked[i];
      if (entry?.sessionId !== sessionId) continue;
      clearTimeout(entry.bannerTimer);
      this.tracked.splice(i, 1);
    }
    this.published.delete(sessionId);
    this.notified.delete(sessionId);
  }

  // --- screen sharing ------------------------------------------------------------------------

  private forMeeting(meetingId: string): Tracked[] {
    return this.tracked.filter((entry) => entry.meetingId === meetingId);
  }

  private onShareStarted(meetingId: string, kind: 'screen' | 'window', rect: Rect): void {
    const mode = this.deps.settings().meetings.addSharedScreen;
    for (const entry of this.forMeeting(meetingId)) {
      entry.sharing = true;
      this.publish(entry.sessionId);
      if (mode === 'off') continue;
      void this.handleShare(entry, kind, rect, mode).catch((error: unknown) =>
        this.deps.log(
          `shared screen not handled: ${error instanceof Error ? error.message : 'error'}`,
        ),
      );
    }
  }

  private async handleShare(
    entry: Tracked,
    kind: 'screen' | 'window',
    rect: Rect,
    mode: 'auto' | 'ask',
  ): Promise<void> {
    const display = kind === 'screen' ? this.sharedDisplay(entry.app, rect) : undefined;
    if (display) {
      if (this.deps.recorder.shownDisplayIds(entry.sessionId).includes(display.id)) {
        return this.setBanner(entry, 'share-already', ALREADY_BANNER_MS);
      }
      if (mode === 'auto') {
        try {
          const { slot } = await this.deps.recorder.addPanel({
            sessionId: entry.sessionId,
            kind: 'screen',
            displayId: display.id,
          });
          if (entry.sharing && this.tracked.includes(entry)) entry.sharePanel = slot;
          else this.removeQuietly(entry.sessionId, slot);
          return;
        } catch (error) {
          // The panel could not be added (the cap, say): the user may choose what to add.
          this.deps.log(
            `shared screen not added: ${error instanceof Error ? error.message : 'error'}`,
          );
        }
      }
    }
    if (entry.sharing && this.tracked.includes(entry)) this.setBanner(entry, 'share-ask');
  }

  /**
   * The screen being shared. One display: that one. Zoom's share toolbar sits on the shared screen.
   * The indicator of a browser or Teams does not say which screen: unknown with several displays.
   */
  private sharedDisplay(app: MeetingApp, indicator: Rect): DisplayInfo | undefined {
    const displays = this.deps.displays();
    if (displays.length === 1) return displays[0];
    if (app !== 'zoom') return undefined;
    const x = indicator.x + indicator.width / 2;
    const y = indicator.y + indicator.height / 2;
    return displays.find((display) => {
      const box = physicalRect(display);
      return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
    });
  }

  private onShareEnded(meetingId: string): void {
    for (const entry of this.forMeeting(meetingId)) {
      entry.sharing = false;
      clearTimeout(entry.bannerTimer);
      entry.banner = null;
      if (entry.sharePanel !== null) {
        this.removeQuietly(entry.sessionId, entry.sharePanel);
        entry.sharePanel = null;
      }
      this.publish(entry.sessionId);
    }
  }

  private removeQuietly(sessionId: string, slot: number): void {
    try {
      this.deps.recorder.removePanel(sessionId, slot);
    } catch {
      // The panel is gone already (its screen was unplugged, the recording ended).
    }
  }

  private setBanner(
    entry: Tracked,
    banner: 'share-ask' | 'share-already' | null,
    clearAfterMs?: number,
  ): void {
    clearTimeout(entry.bannerTimer);
    entry.bannerTimer = undefined;
    entry.banner = banner;
    entry.panelsAtAsk =
      this.deps.recorder.sessions().find((s) => s.sessionId === entry.sessionId)?.panels ?? 0;
    if (banner !== null && clearAfterMs !== undefined) {
      entry.bannerTimer = setTimeout(() => this.setBanner(entry, null), clearAfterMs);
    }
    this.publish(entry.sessionId);
  }
}
