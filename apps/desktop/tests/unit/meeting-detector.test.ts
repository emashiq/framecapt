import { describe, expect, it } from 'vitest';
import { MeetingDetector, type MeetingDetectorEvent } from '../../src/main/meeting/detector';
import type { WinInfo, WindowProbe } from '../../src/main/platform/window-probe';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

class FakeProbe implements WindowProbe {
  readonly kind = 'mock' as const;
  windows: WinInfo[] = [];
  mic: string[] = [];
  list = () => Promise.resolve(this.windows.map((w) => ({ ...w })));
  get = (hwnd: string) => Promise.resolve(this.windows.find((w) => w.hwnd === hwnd) ?? null);
  micInUse = () => Promise.resolve([...this.mic]);
  foreground = () => Promise.resolve(null);
  dispose = () => undefined;
}

function win(
  hwnd: string,
  title: string,
  className: string,
  exe: string,
  extra: Partial<WinInfo> = {},
): WinInfo {
  return {
    hwnd,
    title,
    className,
    pid: 1,
    exe,
    rect: { x: 100, y: 50, width: 800, height: 600 },
    minimized: false,
    visible: true,
    cloaked: false,
    ...extra,
  };
}

const meetWindow = (hwnd = '10') =>
  win(hwnd, 'Meet – abc-defg-hij - Google Chrome', 'Chrome_WidgetWin_1', 'chrome.exe');
const zoomWindow = (hwnd = '20') =>
  win(hwnd, 'Zoom Meeting', 'ConfMultiTabContentWndClass', 'zoom.exe');
const chromeShare = (hwnd = '90') =>
  win(hwnd, 'meet.google.com is sharing your screen.', 'Chrome_WidgetWin_1', 'chrome.exe', {
    rect: { x: 800, y: 0, width: 400, height: 40 },
  });

function setup(meetings: Partial<Settings['meetings']> = {}) {
  const probe = new FakeProbe();
  let time = 1_000_000;
  const config = { ...structuredClone(DEFAULT_SETTINGS.meetings), ...meetings };
  let quitting = false;
  const detector = new MeetingDetector({
    probe,
    now: () => time,
    setInterval: () => 1,
    clearInterval: () => undefined,
    settings: () => config,
    isQuitting: () => quitting,
  });
  const events: MeetingDetectorEvent[] = [];
  detector.onEvent((event) => events.push(event));
  return {
    probe,
    detector,
    events,
    config,
    advance: (ms: number) => {
      time += ms;
    },
    quit: () => {
      quitting = true;
    },
    types: () => events.map((event) => event.type),
  };
}

describe('MeetingDetector', () => {
  it('confirms a meeting after two consecutive matching polls, once', async () => {
    const t = setup();
    t.probe.windows = [meetWindow()];
    await t.detector.poll();
    expect(t.events).toEqual([]);
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted']);
    const started = t.events[0];
    if (started?.type !== 'meetingStarted') throw new Error('expected meetingStarted');
    expect(started.meeting).toMatchObject({
      app: 'meet',
      hwnd: '10',
      sourceId: 'window:10:0',
      displayBounds: { x: 100, y: 50, width: 800, height: 600 },
    });
    expect(started.meeting.meetingId).toMatch(/^[0-9a-f-]{36}$/);
    for (let i = 0; i < 3; i += 1) {
      t.advance(2000);
      await t.detector.poll();
    }
    expect(t.types()).toEqual(['meetingStarted']);
    expect(t.detector.current()).toHaveLength(1);
  });

  it('does not confirm a window that matched only once in a row', async () => {
    const t = setup();
    t.probe.windows = [meetWindow()];
    await t.detector.poll();
    t.probe.windows = [];
    t.advance(2000);
    await t.detector.poll();
    t.probe.windows = [meetWindow()];
    t.advance(2000);
    await t.detector.poll();
    expect(t.events).toEqual([]);
  });

  it('ends a meeting 60 s after its window stopped matching while the window still exists', async () => {
    const t = setup();
    t.probe.windows = [meetWindow()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    // The user switched to another tab: the window exists, the title no longer matches.
    t.probe.windows = [win('10', 'Inbox - Google Chrome', 'Chrome_WidgetWin_1', 'chrome.exe')];
    for (let i = 0; i < 20; i += 1) {
      t.advance(2000);
      await t.detector.poll();
    }
    expect(t.types()).toEqual(['meetingStarted']);
    t.advance(30_000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted', 'meetingEnded']);
    expect(t.detector.current()).toEqual([]);
  });

  it('continues the same meeting when the tab comes back within the grace', async () => {
    const t = setup();
    t.probe.windows = [meetWindow()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    t.probe.windows = [win('10', 'Inbox - Google Chrome', 'Chrome_WidgetWin_1', 'chrome.exe')];
    t.advance(10_000);
    await t.detector.poll();
    t.probe.windows = [meetWindow()];
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted']);
  });

  it('ends at once after two misses when the window no longer exists', async () => {
    const t = setup();
    t.probe.windows = [zoomWindow()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    t.probe.windows = [];
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted']);
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted', 'meetingEnded']);
  });

  it('needs the microphone for a Teams call window and skips the main window', async () => {
    const t = setup();
    t.probe.windows = [
      win('30', 'Chat | Microsoft Teams', 'TeamsWebView', 'ms-teams.exe'),
      win('31', 'Weekly sync', 'TeamsWebView', 'ms-teams.exe'),
    ];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    expect(t.events).toEqual([]);
    t.probe.mic = ['msteams_8wekyb3d8bbwe'];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted']);
    expect(t.detector.current()[0]).toMatchObject({ app: 'teams', hwnd: '31' });
  });

  it('tracks one Teams window: the one it already has, else the newest', async () => {
    const t = setup();
    t.probe.mic = ['msteams_8wekyb3d8bbwe'];
    t.probe.windows = [win('31', 'Weekly sync', 'TeamsWebView', 'ms-teams.exe')];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    t.probe.windows.push(win('32', 'Popout', 'TeamsWebView', 'ms-teams.exe'));
    t.advance(2000);
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    expect(t.detector.current().map((m) => m.hwnd)).toEqual(['31']);
    expect(t.types()).toEqual(['meetingStarted']);
  });

  it('reports a share start and end, tied to the meeting', async () => {
    const t = setup();
    t.probe.windows = [meetWindow()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    t.probe.windows = [meetWindow(), chromeShare()];
    t.advance(2000);
    await t.detector.poll();
    const meetingId = t.detector.current()[0]?.meetingId;
    expect(t.events[1]).toEqual({
      type: 'shareStarted',
      meetingId,
      kind: 'screen',
      indicatorRect: { x: 800, y: 0, width: 400, height: 40 },
    });
    expect(t.detector.current()[0]?.sharing).toBe(true);
    // One missed poll is tolerated; the second ends the share.
    t.probe.windows = [meetWindow()];
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted', 'shareStarted']);
    t.advance(2000);
    await t.detector.poll();
    expect(t.events[2]).toEqual({ type: 'shareEnded', meetingId });
    expect(t.detector.current()[0]?.sharing).toBe(false);
  });

  it('ends the share before the meeting when the meeting ends', async () => {
    const t = setup();
    t.probe.windows = [meetWindow(), chromeShare()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    t.probe.windows = [];
    t.advance(2000);
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted', 'shareStarted', 'shareEnded', 'meetingEnded']);
  });

  it('ignores a share indicator when there is no meeting', async () => {
    const t = setup();
    t.probe.windows = [chromeShare()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    expect(t.events).toEqual([]);
  });

  it('ignores an app that is switched off, and ends its meeting when it is switched off', async () => {
    const t = setup({ apps: { meet: false, zoom: true, teams: true, webex: true } });
    t.probe.windows = [meetWindow(), zoomWindow()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    expect(t.detector.current().map((m) => m.app)).toEqual(['zoom']);
    t.config.apps.zoom = false;
    t.advance(2000);
    await t.detector.poll();
    expect(t.types()).toEqual(['meetingStarted', 'meetingEnded']);
  });

  it('does nothing when detection is off, and stop() ends the meetings', async () => {
    const t = setup();
    t.probe.windows = [meetWindow()];
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    t.detector.stop();
    expect(t.types()).toEqual(['meetingStarted', 'meetingEnded']);
    t.config.detect = false;
    await t.detector.poll();
    t.advance(2000);
    await t.detector.poll();
    expect(t.events).toHaveLength(2);
  });

  it('does not poll while the app is quitting', async () => {
    const t = setup();
    t.probe.windows = [meetWindow()];
    t.quit();
    await t.detector.poll();
    await t.detector.poll();
    expect(t.events).toEqual([]);
  });

  it('starts and stops its timer', () => {
    const calls: string[] = [];
    const detector = new MeetingDetector({
      probe: new FakeProbe(),
      now: () => 0,
      setInterval: (_callback, ms) => {
        calls.push(`set ${ms}`);
        return 7;
      },
      clearInterval: (handle) => calls.push(`clear ${String(handle)}`),
      settings: () => DEFAULT_SETTINGS.meetings,
      intervalMs: 250,
    });
    detector.start();
    detector.start();
    detector.stop();
    expect(calls).toEqual(['set 250', 'clear 7']);
  });
});
