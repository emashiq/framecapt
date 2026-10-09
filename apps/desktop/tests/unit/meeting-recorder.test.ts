import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisplayInfo } from '../../src/main/capture/types';
import type { MeetingInfo } from '../../src/main/meeting/detector';
import {
  MeetingRecorder,
  type MeetingRecorderDeps,
  type MeetingRecorderPort,
  type MeetingSource,
} from '../../src/main/meeting/meeting-recorder';
import type { WinInfo } from '../../src/main/platform/window-probe';
import type { PanelKind, PanelPlaceholder, PanelSlot } from '../../src/shared/panels';
import type {
  RecorderSessionSummary,
  RecorderStartRequest,
  SessionMeeting,
} from '../../src/shared/recorder-ipc';
import type { RecorderStatus } from '../../src/shared/recorder-machine';
import type { Rect } from '../../src/shared/rect';
import { DEFAULT_RECORD_OPTIONS } from '../../src/shared/recorder-ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

const display = (id: string, x: number, primary = false): DisplayInfo => ({
  id,
  label: `Display ${id}`,
  bounds: { x, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  rotation: 0,
  physicalSize: { width: 1920, height: 1080 },
  isPrimary: primary,
});
const DISPLAY_A = display('A', 0, true);
const DISPLAY_B = display('B', 1920);

function win(overrides: Partial<WinInfo> = {}): WinInfo {
  return {
    hwnd: '10',
    title: 'Zoom Meeting',
    className: 'ConfMultiTabContentWndClass',
    pid: 1,
    exe: 'zoom.exe',
    rect: { x: 0, y: 0, width: 800, height: 600 },
    minimized: false,
    visible: true,
    cloaked: false,
    ...overrides,
  };
}

const ZOOM: MeetingInfo = {
  meetingId: 'm1',
  app: 'zoom',
  hwnd: '10',
  sourceId: 'window:10:0',
  sharing: false,
};
const MEET: MeetingInfo = {
  meetingId: 'm2',
  app: 'meet',
  hwnd: '11',
  sourceId: 'window:11:0',
  sharing: false,
};

interface FakeSession {
  summary: RecorderSessionSummary;
  panels: PanelSlot[];
  addDisabled: boolean;
  shown: string[];
}

class FakeRecorder implements MeetingRecorderPort {
  readonly sessionsById = new Map<string, FakeSession>();
  readonly requests: RecorderStartRequest[] = [];
  readonly hidden: string[] = [];
  readonly removed: string[] = [];
  readonly added: string[] = [];
  readonly meetingOf = new Map<string, SessionMeeting | null>();
  private listeners = new Set<() => void>();
  /** The status a new recording reaches after start (null: it stays starting). */
  startsAs: RecorderStatus | null = 'recording';
  failPanel = false;
  private next = 1;

  add(
    status: RecorderStatus,
    overrides: { target?: RecorderSessionSummary['target']; addDisabled?: boolean } = {},
  ): string {
    const sessionId = `s${this.next}`;
    this.next += 1;
    this.sessionsById.set(sessionId, {
      summary: {
        sessionId,
        label: `Recording ${this.next - 1}`,
        status,
        target: overrides.target ?? 'screen',
        activeMs: 0,
        runningSince: null,
        progress: null,
        quitting: false,
        panels: 0,
        meeting: null,
      },
      panels: [],
      addDisabled: overrides.addDisabled ?? false,
      shown: overrides.target === 'screen' || overrides.target === undefined ? ['A'] : [],
    });
    return sessionId;
  }

  setStatus(sessionId: string, status: RecorderStatus): void {
    const session = this.sessionsById.get(sessionId);
    if (session) session.summary.status = status;
    this.emit();
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  start(request: RecorderStartRequest): Promise<{ sessionId: string }> {
    this.requests.push(request);
    const sessionId = this.add('selecting', {
      target: request.target,
    });
    const session = this.sessionsById.get(sessionId);
    if (session) {
      session.shown = request.target === 'screen' && request.displayId ? [request.displayId] : [];
    }
    if (this.startsAs) {
      const status = this.startsAs;
      queueMicrotask(() => this.setStatus(sessionId, status));
    }
    return Promise.resolve({ sessionId });
  }

  sessions(): RecorderSessionSummary[] {
    return [...this.sessionsById.values()].map((session) => ({
      ...session.summary,
      panels: session.panels.length,
    }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  panelState(sessionId: string | undefined) {
    const session = sessionId ? this.sessionsById.get(sessionId) : undefined;
    return session
      ? {
          sessionId: session.summary.sessionId,
          panels: [...session.panels],
          addDisabled: session.addDisabled,
        }
      : undefined;
  }

  private addToSession(sessionId: string, kind: PanelKind, label: string): number {
    const session = this.sessionsById.get(sessionId);
    if (!session || this.failPanel) throw new Error('cannot add');
    const slot = [1, 2, 3].find((n) => !session.panels.some((panel) => panel.slot === n)) ?? 1;
    session.panels.push({
      slot,
      kind,
      label: `Panel ${slot + 1}`,
      hidden: false,
      placeholder: null,
    });
    this.added.push(`${sessionId} ${label}`);
    this.emit();
    return slot;
  }

  addPanelSource(sessionId: string, source: { kind: PanelKind; sourceId: string }) {
    return Promise.resolve(this.addToSession(sessionId, source.kind, source.sourceId));
  }

  addPanel(request: { sessionId: string; kind: 'screen'; displayId: string }) {
    const slot = this.addToSession(request.sessionId, 'screen', `screen ${request.displayId}`);
    this.sessionsById.get(request.sessionId)?.shown.push(request.displayId);
    return Promise.resolve({ slot });
  }

  removePanel(sessionId: string, slot: number): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) throw new Error('gone');
    session.panels = session.panels.filter((panel) => panel.slot !== slot);
    this.removed.push(`${sessionId}/${slot}`);
    this.emit();
  }

  setPanelHidden(sessionId: string, slot: number, hidden: boolean, placeholder: PanelPlaceholder) {
    this.hidden.push(`${sessionId}/${slot} ${hidden ? 'hide' : 'show'} ${placeholder}`);
  }

  setSessionMeeting(sessionId: string, meeting: SessionMeeting | null): void {
    this.meetingOf.set(sessionId, meeting);
    this.emit(); // the real recorder reports every change
  }

  shownDisplayIds(sessionId: string): string[] {
    return this.sessionsById.get(sessionId)?.shown ?? [];
  }
}

class FakeMeetings implements MeetingSource {
  meetings: MeetingInfo[] = [ZOOM, MEET];
  windows = new Map<string, WinInfo | null>([
    ['10', win()],
    ['11', win({ hwnd: '11', title: 'Meet – abc-defg-hij - Google Chrome', exe: 'chrome.exe' })],
  ]);
  shareStarted: Parameters<MeetingSource['onShareStarted']>[0][] = [];
  shareEnded: ((id: string) => void)[] = [];
  ended: ((id: string) => void)[] = [];
  find(meetingId: string) {
    return this.meetings.find((meeting) => meeting.meetingId === meetingId);
  }
  getWindow(hwnd: string) {
    return Promise.resolve(this.windows.get(hwnd) ?? null);
  }
  onShareStarted(listener: Parameters<MeetingSource['onShareStarted']>[0]) {
    this.shareStarted.push(listener);
    return () => undefined;
  }
  onShareEnded(listener: (id: string) => void) {
    this.shareEnded.push(listener);
    return () => undefined;
  }
  onMeetingEnded(listener: (id: string) => void) {
    this.ended.push(listener);
    return () => undefined;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let current: MeetingRecorder | undefined;

afterEach(() => {
  current?.dispose();
  current = undefined;
  vi.useRealTimers();
});

function setup(
  options: {
    meetings?: Partial<Settings['meetings']>;
    recording?: Partial<Settings['recording']>;
    notifications?: boolean;
    displays?: DisplayInfo[];
    cursor?: string;
  } = {},
) {
  const recorder = new FakeRecorder();
  const meetings = new FakeMeetings();
  const toasts: string[] = [];
  const notes: string[] = [];
  let tick: (() => void) | undefined;
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    general: { ...DEFAULT_SETTINGS.general, showNotifications: options.notifications ?? true },
    recording: { ...DEFAULT_SETTINGS.recording, ...options.recording },
    meetings: { ...DEFAULT_SETTINGS.meetings, ...options.meetings },
  };
  const deps: MeetingRecorderDeps = {
    recorder,
    meetings,
    settings: () => settings,
    displays: () => options.displays ?? [DISPLAY_A, DISPLAY_B],
    cursorDisplayId: () => options.cursor,
    toast: (message) => toasts.push(message),
    notify: (title, body) => notes.push(`${title}: ${body}`),
    setInterval: (callback) => {
      tick = callback;
      return 'timer';
    },
    clearInterval: () => {
      tick = undefined;
    },
    log: () => undefined,
  };
  const meetingRecorder = new MeetingRecorder(deps);
  current = meetingRecorder;
  return {
    recorder,
    meetings,
    toasts,
    notes,
    meetingRecorder,
    /** One look at the meeting windows. */
    look: async () => {
      tick?.();
      await flush();
    },
    meetingOf: (sessionId: string) => recorder.meetingOf.get(sessionId) ?? null,
  };
}

describe('starting a meeting recording', () => {
  it('records the meeting window alone, with a microphone and the call audio, without a countdown', async () => {
    const t = setup();
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: false });
    await flush();

    expect(t.recorder.requests).toHaveLength(1);
    const [request] = t.recorder.requests;
    expect(request).toMatchObject({ target: 'window', sourceId: 'window:10:0' });
    expect(request?.options).toMatchObject({
      mic: { enabled: true },
      systemAudio: true,
      countdown: false,
      quality: DEFAULT_SETTINGS.recording.quality,
      fps: DEFAULT_SETTINGS.recording.fps,
    });
    expect(t.meetingOf('s1')).toMatchObject({
      app: 'zoom',
      appLabel: 'Zoom',
      state: 'visible',
      banner: null,
    });
    expect(t.toasts).toEqual([]);
  });

  it('keeps the microphone the user chose in the settings', async () => {
    const t = setup({ recording: { micEnabled: false, micDeviceId: 'usb-mic' } });
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: false });
    expect(t.recorder.requests[0]?.options.mic).toEqual({ enabled: true, deviceId: 'usb-mic' });
  });

  it('records the screen under the mouse with the meeting window added as a panel', async () => {
    const t = setup({ cursor: 'B' });
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: true });
    await flush();

    expect(t.recorder.requests[0]).toMatchObject({ target: 'screen', displayId: 'B' });
    expect(t.recorder.added).toEqual(['s1 window:10:0']);
    expect(t.meetingOf('s1')?.state).toBe('visible');
  });

  it('uses the screen that was asked for, else the primary one', async () => {
    const asked = setup({ cursor: 'B' });
    await asked.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: true, displayId: 'A' });
    expect(asked.recorder.requests[0]).toMatchObject({ displayId: 'A' });

    const fallback = setup();
    await fallback.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: true });
    expect(fallback.recorder.requests[0]).toMatchObject({ displayId: 'A' });
  });

  it('waits for the recording to be live before it adds the window', async () => {
    const t = setup();
    t.recorder.startsAs = null;
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: true });
    await flush();
    expect(t.recorder.added).toEqual([]);
    t.recorder.setStatus('s1', 'recording');
    await flush();
    expect(t.recorder.added).toEqual(['s1 window:10:0']);
  });

  it('does not start when the meeting window is minimized, and says what to do', async () => {
    const t = setup();
    t.meetings.windows.set('10', win({ minimized: true }));
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: false });
    expect(t.recorder.requests).toEqual([]);
    expect(t.toasts).toEqual(['Bring the Zoom window to the front, then try again.']);
  });

  it('does not start for a Meet tab that is not the active tab', async () => {
    const t = setup();
    t.meetings.windows.set(
      '11',
      win({ hwnd: '11', title: 'Inbox - Google Chrome', exe: 'chrome.exe' }),
    );
    await t.meetingRecorder.startMeetingRecording(MEET, { withScreen: false });
    expect(t.recorder.requests).toEqual([]);
    expect(t.toasts).toEqual(['Bring the Google Meet window to the front, then try again.']);
  });

  it('does not start for a window that is gone', async () => {
    const t = setup();
    t.meetings.windows.set('10', null);
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: false });
    expect(t.recorder.requests).toEqual([]);
    expect(t.toasts).toEqual(['The Zoom window is no longer available.']);
  });

  it('starts with the screen when the window is minimized, shows it hidden and adds it once it is shown', async () => {
    const t = setup();
    t.meetings.windows.set('10', win({ minimized: true }));
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: true });
    await flush();
    expect(t.recorder.requests).toHaveLength(1);
    expect(t.recorder.added).toEqual([]);
    expect(t.meetingOf('s1')?.state).toBe('hidden');

    await t.look();
    expect(t.recorder.added).toEqual([]); // still minimized

    t.meetings.windows.set('10', win());
    await t.look();
    expect(t.recorder.added).toEqual(['s1 window:10:0']);
    expect(t.meetingOf('s1')?.state).toBe('visible');
  });

  it('tells the user when a failure comes from the recorder (a fourth recording)', async () => {
    const t = setup();
    t.recorder.start = () =>
      Promise.reject(Object.assign(new Error('The most recordings'), { code: 'BUSY' }));
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: false });
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]).toContain('Another capture or recording is already running');
  });

  it('a recorder:start request must name a meeting main knows, and a displayId asks for the screen', async () => {
    const t = setup();
    const request = (meetingId: string, displayId?: string): RecorderStartRequest => ({
      target: 'meeting',
      meeting: { meetingId, app: 'zoom', sourceId: 'window:10:0' },
      ...(displayId && { displayId }),
      options: DEFAULT_RECORD_OPTIONS,
    });
    await expect(t.meetingRecorder.startFromRequest(request('nope'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(t.meetingRecorder.startFromRequest(request('m1'))).resolves.toEqual({
      sessionId: 's1',
    });
    expect(t.recorder.requests[0]?.target).toBe('window');
    await t.meetingRecorder.startFromRequest(request('m1', 'B'));
    expect(t.recorder.requests[1]).toMatchObject({ target: 'screen', displayId: 'B' });
  });

  it('a minimized window in a recorder:start request is an error the caller sees', async () => {
    const t = setup();
    t.meetings.windows.set('10', win({ minimized: true }));
    await expect(
      t.meetingRecorder.startFromRequest({
        target: 'meeting',
        meeting: { meetingId: 'm1', app: 'zoom', sourceId: 'window:10:0' },
        options: DEFAULT_RECORD_OPTIONS,
      }),
    ).rejects.toMatchObject({ message: 'Bring the Zoom window to the front, then try again.' });
  });

  it('recordById names a meeting that is gone', async () => {
    const t = setup();
    await expect(t.meetingRecorder.recordById('nope', false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('a meeting window that is hidden during the recording', () => {
  async function recording() {
    const t = setup();
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: false });
    await flush();
    return t;
  }

  it('is replaced by a card, and the toolbar says so (after two looks)', async () => {
    const t = await recording();
    t.meetings.windows.set('10', win({ minimized: true }));
    await t.look();
    expect(t.meetingOf('s1')?.state).toBe('visible');
    await t.look();
    expect(t.recorder.hidden).toEqual(['s1/0 hide meeting-hidden']);
    expect(t.meetingOf('s1')?.state).toBe('hidden');

    t.meetings.windows.set('10', win());
    await t.look();
    expect(t.recorder.hidden).toEqual(['s1/0 hide meeting-hidden', 's1/0 show meeting-hidden']);
    expect(t.meetingOf('s1')?.state).toBe('visible');
  });

  it('sends one notification for the first hide of a recording', async () => {
    const t = await recording();
    for (const minimized of [true, true, false, true, true]) {
      t.meetings.windows.set('10', win({ minimized }));
      await t.look();
    }
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toContain('Zoom window is hidden');
  });

  it('sends no notification when notifications are off', async () => {
    const t = setup({ notifications: false });
    await t.meetingRecorder.startMeetingRecording(ZOOM, { withScreen: false });
    await flush();
    t.meetings.windows.set('10', win({ minimized: true }));
    await t.look();
    await t.look();
    expect(t.notes).toEqual([]);
    expect(t.meetingOf('s1')?.state).toBe('hidden');
  });

  it('shows "Meeting ended" when the detector ends the meeting, and does not stop the recording', async () => {
    const t = await recording();
    for (const listener of t.meetings.ended) listener('m1');
    expect(t.recorder.hidden).toEqual(['s1/0 hide meeting-ended']);
    expect(t.meetingOf('s1')?.state).toBe('ended');
    expect(t.recorder.sessionsById.get('s1')?.summary.status).toBe('recording');
  });

  it('shows "Meeting ended" when the window is gone', async () => {
    const t = await recording();
    t.meetings.windows.set('10', null);
    await t.look();
    expect(t.meetingOf('s1')?.state).toBe('ended');
  });

  it('stops watching when the recording ends', async () => {
    const t = await recording();
    t.recorder.setStatus('s1', 'completed');
    t.meetings.windows.set('10', win({ minimized: true }));
    await t.look();
    await t.look();
    expect(t.recorder.hidden).toEqual([]);
  });
});

describe('adding a meeting to a running recording', () => {
  it('adds the window as a panel of the live recording and watches it', async () => {
    const t = setup();
    const id = t.recorder.add('recording');
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    expect(t.recorder.added).toEqual([`${id} window:10:0`]);
    expect(t.meetingOf(id)).toMatchObject({ app: 'zoom', state: 'visible' });

    t.meetings.windows.set('10', win({ cloaked: true }));
    await t.look();
    await t.look();
    expect(t.recorder.hidden).toEqual([`${id}/1 hide meeting-hidden`]);
  });

  it('goes to the primary live recording (the newest live one)', async () => {
    const t = setup();
    t.recorder.add('recording');
    const second = t.recorder.add('paused');
    t.recorder.add('completed');
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    expect(t.recorder.added).toEqual([`${second} window:10:0`]);
  });

  it('says so when nothing is recording', async () => {
    const t = setup();
    t.recorder.add('completed');
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    expect(t.toasts).toEqual(['There is no recording to add to.']);
  });

  it('is refused for a recording of several sources', async () => {
    const t = setup();
    t.recorder.add('recording', { target: 'multi', addDisabled: true });
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    expect(t.toasts).toEqual(["This recording can't take another panel."]);
    expect(t.recorder.added).toEqual([]);
  });

  it('is refused at the panel cap', async () => {
    const t = setup();
    t.recorder.add('recording', { addDisabled: true });
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    expect(t.toasts).toEqual(["This recording can't take another panel."]);
  });

  it('is refused for a minimized window', async () => {
    const t = setup();
    t.recorder.add('recording');
    t.meetings.windows.set('10', win({ minimized: true }));
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    expect(t.toasts).toEqual(['Bring the Zoom window to the front, then try again.']);
    expect(t.recorder.added).toEqual([]);
  });

  it('does not add the same meeting twice', async () => {
    const t = setup();
    t.recorder.add('recording');
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    expect(t.recorder.added).toHaveLength(1);
    expect(t.toasts).toEqual(['The Zoom meeting is already in the recording.']);
  });

  it('forgets the meeting when its panel is taken out of the recording', async () => {
    const t = setup();
    const id = t.recorder.add('recording');
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    t.recorder.removePanel(id, 1);
    expect(t.meetingOf(id)).toBeNull();
  });
});

describe('a screen shared in the meeting', () => {
  const INDICATOR_ON_B: Rect = { x: 2000, y: 20, width: 300, height: 40 };

  async function zoomRecording(meetings: Partial<Settings['meetings']> = {}) {
    const t = setup({ meetings });
    const id = t.recorder.add('recording');
    await t.meetingRecorder.addMeetingToRecording(ZOOM);
    return {
      t,
      id,
      share: (kind: 'screen' | 'window' = 'screen', rect = INDICATOR_ON_B) => {
        for (const listener of t.meetings.shareStarted) listener('m1', kind, rect);
      },
      stopShare: () => {
        for (const listener of t.meetings.shareEnded) listener('m1');
      },
    };
  }

  it("adds the shared screen on its own: Zoom's toolbar sits on it", async () => {
    const { t, id, share } = await zoomRecording();
    share();
    await flush();
    expect(t.recorder.added).toContain(`${id} screen B`);
    expect(t.meetingOf(id)).toMatchObject({ sharing: true, banner: null });
  });

  it('takes the shared screen out again when the share ends', async () => {
    const { t, id, share, stopShare } = await zoomRecording();
    share();
    await flush();
    stopShare();
    expect(t.recorder.removed).toEqual([`${id}/2`]);
    expect(t.meetingOf(id)).toMatchObject({ sharing: false, banner: null });
  });

  it('does not take out a screen the user added themselves', async () => {
    const { t, id, share, stopShare } = await zoomRecording({ addSharedScreen: 'ask' });
    share();
    await flush();
    t.recorder.addPanel({ sessionId: id, kind: 'screen', displayId: 'B' });
    stopShare();
    expect(t.recorder.removed).toEqual([]);
  });

  it('says the screen is already in the recording, for five seconds', async () => {
    vi.useFakeTimers();
    const { t, id, share } = await zoomRecording();
    t.recorder.sessionsById.get(id)?.shown.push('B');
    share();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.meetingOf(id)?.banner).toBe('share-already');
    expect(t.recorder.added).toEqual([`${id} window:10:0`]); // only the meeting window
    await vi.advanceTimersByTimeAsync(4900);
    expect(t.meetingOf(id)?.banner).toBe('share-already');
    await vi.advanceTimersByTimeAsync(200);
    expect(t.meetingOf(id)?.banner).toBeNull();
  });

  it("also says so when the recording's own screen is the shared one", async () => {
    const { t, id, share } = await zoomRecording();
    t.recorder.sessionsById.get(id)?.shown.push('A');
    share('screen', { x: 100, y: 20, width: 300, height: 40 });
    await flush();
    expect(t.meetingOf(id)?.banner).toBe('share-already');
  });

  it('asks when the setting is "ask", and the question goes away when a panel is added', async () => {
    const { t, id, share } = await zoomRecording({ addSharedScreen: 'ask' });
    share();
    await flush();
    expect(t.meetingOf(id)?.banner).toBe('share-ask');
    expect(t.recorder.added).toEqual([`${id} window:10:0`]);

    await t.recorder.addPanel({ sessionId: id, kind: 'screen', displayId: 'B' });
    expect(t.meetingOf(id)?.banner).toBeNull();
  });

  it('does nothing when the setting is "off" (it only notes that a share is going on)', async () => {
    const { t, id, share } = await zoomRecording({ addSharedScreen: 'off' });
    share();
    await flush();
    expect(t.recorder.added).toEqual([`${id} window:10:0`]);
    expect(t.meetingOf(id)).toMatchObject({ sharing: true, banner: null });
  });

  it('asks when the screen is unknown: a browser indicator with two displays', async () => {
    const t = setup();
    const id = t.recorder.add('recording');
    await t.meetingRecorder.addMeetingToRecording(MEET);
    for (const listener of t.meetings.shareStarted) listener('m2', 'screen', INDICATOR_ON_B);
    await flush();
    expect(t.meetingOf(id)?.banner).toBe('share-ask');
    expect(t.recorder.added).toEqual([`${id} window:11:0`]);
    for (const listener of t.meetings.shareEnded) listener('m2');
    expect(t.meetingOf(id)?.banner).toBeNull();
  });

  it('adds the only screen when there is one display, whoever shares', async () => {
    const t = setup({ displays: [DISPLAY_A] });
    const id = t.recorder.add('recording', { target: 'window' });
    await t.meetingRecorder.addMeetingToRecording(MEET);
    for (const listener of t.meetings.shareStarted) listener('m2', 'screen', INDICATOR_ON_B);
    await flush();
    expect(t.recorder.added).toContain(`${id} screen A`);
  });

  it('asks for a shared window: which one is not known', async () => {
    const { t, id, share } = await zoomRecording();
    share('window');
    await flush();
    expect(t.meetingOf(id)?.banner).toBe('share-ask');
    expect(t.recorder.added).toEqual([`${id} window:10:0`]);
  });

  it('asks when the screen could not be added', async () => {
    const { t, id, share } = await zoomRecording();
    t.recorder.failPanel = true;
    share();
    await flush();
    expect(t.meetingOf(id)?.banner).toBe('share-ask');
  });

  it('a share that ended while the screen was being added leaves nothing behind', async () => {
    const { t, id, share, stopShare } = await zoomRecording();
    share();
    stopShare();
    await flush();
    expect(t.recorder.removed).toEqual([`${id}/2`]);
  });
});
