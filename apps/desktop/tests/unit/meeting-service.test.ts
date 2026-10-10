import { describe, expect, it } from 'vitest';
import type { MeetingDetectorEvent, MeetingInfo } from '../../src/main/meeting/detector';
import {
  MeetingService,
  type DetectorPort,
  type MeetingActions,
} from '../../src/main/meeting/service';
import type { MeetingList, MeetingPromptEvent } from '../../src/shared/meeting-ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

class FakeDetector implements DetectorPort {
  meetings: MeetingInfo[] = [];
  listener: ((event: MeetingDetectorEvent) => void) | undefined;
  running = false;
  onEvent(listener: (event: MeetingDetectorEvent) => void) {
    this.listener = listener;
    return () => undefined;
  }
  start() {
    this.running = true;
  }
  stop() {
    this.running = false;
  }
  current() {
    return this.meetings.map((m) => ({ ...m }));
  }
  getWindow() {
    return Promise.resolve(null);
  }
  begin(app: MeetingInfo['app'], meetingId = `m-${this.meetings.length + 1}`): MeetingInfo {
    const meeting: MeetingInfo = {
      meetingId,
      app,
      hwnd: '10',
      sourceId: 'window:10:0',
      sharing: false,
    };
    this.meetings.push(meeting);
    this.listener?.({ type: 'meetingStarted', meeting });
    return meeting;
  }
  end(meetingId: string) {
    this.meetings = this.meetings.filter((m) => m.meetingId !== meetingId);
    this.listener?.({ type: 'meetingEnded', meetingId });
  }
}

function setup(meetings: Partial<Settings['meetings']> = {}, live = false) {
  const detector = new FakeDetector();
  let config: Settings['meetings'] = { ...structuredClone(DEFAULT_SETTINGS.meetings), ...meetings };
  const changeListeners: ((m: Settings['meetings']) => void)[] = [];
  const shown: { event: MeetingPromptEvent; timeoutMs: number }[] = [];
  const closed: (string | undefined)[] = [];
  const calls: string[] = [];
  const published: MeetingList[] = [];
  const actions: MeetingActions = {
    startMeetingRecording: (meeting, options) => {
      calls.push(`start ${meeting.app} screen=${String(options.withScreen)}`);
    },
    addMeetingToRecording: (meeting) => {
      calls.push(`add ${meeting.app}`);
    },
  };
  const service = new MeetingService({
    detector,
    settings: {
      get: () => config,
      update: (patch) => {
        config = { ...config, ...patch };
        for (const listener of changeListeners) listener(config);
      },
      onChange: (listener) => changeListeners.push(listener),
    },
    prompt: {
      show: (event, timeoutMs) => shown.push({ event, timeoutMs }),
      close: (id) => closed.push(id),
    },
    actions,
    recordingLive: () => live,
    publish: (list) => published.push(list),
    log: () => undefined,
  });
  return { service, detector, shown, closed, calls, published, config: () => config };
}

describe('MeetingService', () => {
  it('finds a meeting by id, with the window facts the list leaves out', () => {
    const t = setup();
    const meeting = t.detector.begin('zoom');
    expect(t.service.find(meeting.meetingId)).toMatchObject({
      app: 'zoom',
      hwnd: '10',
      sourceId: 'window:10:0',
    });
    expect(t.service.find('nope')).toBeUndefined();
    t.detector.end(meeting.meetingId);
    expect(t.service.find(meeting.meetingId)).toBeUndefined();
  });

  it('prompts once per meeting, with the app label and the recording state', () => {
    const t = setup({}, true);
    const meeting = t.detector.begin('zoom');
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]).toEqual({
      event: { meetingId: meeting.meetingId, app: 'zoom', appLabel: 'Zoom', recordingLive: true },
      timeoutMs: 30_000,
    });
    t.detector.listener?.({ type: 'meetingStarted', meeting });
    expect(t.shown).toHaveLength(1);
  });

  it('does not prompt for a muted or disabled app, or when detection is off', () => {
    const muted = setup({ mutedApps: ['meet'] });
    muted.detector.begin('meet');
    expect(muted.shown).toEqual([]);
    const off = setup({ detect: false });
    off.detector.begin('zoom');
    expect(off.shown).toEqual([]);
    const disabled = setup({ apps: { meet: true, zoom: false, teams: true, webex: true } });
    disabled.detector.begin('zoom');
    expect(disabled.shown).toEqual([]);
  });

  it('mute-app adds the app to the settings and the next meeting is not prompted', () => {
    const t = setup();
    const meeting = t.detector.begin('webex');
    t.service.respond(meeting.meetingId, 'mute-app');
    expect(t.config().mutedApps).toEqual(['webex']);
    t.service.respond(meeting.meetingId, 'mute-app');
    expect(t.config().mutedApps).toEqual(['webex']);
    t.detector.begin('webex');
    expect(t.shown).toHaveLength(1);
  });

  it('dismiss closes the prompt and does not prompt that meeting again', () => {
    const t = setup();
    const meeting = t.detector.begin('meet');
    t.service.respond(meeting.meetingId, 'dismiss');
    expect(t.closed).toContain(meeting.meetingId);
    t.detector.listener?.({ type: 'meetingStarted', meeting });
    expect(t.shown).toHaveLength(1);
    expect(t.calls).toEqual([]);
  });

  it('runs the recording actions', async () => {
    const t = setup();
    const meeting = t.detector.begin('teams');
    t.service.respond(meeting.meetingId, 'record');
    t.service.respond(meeting.meetingId, 'record-with-screen');
    t.service.respond(meeting.meetingId, 'add-to-recording');
    await Promise.resolve();
    await Promise.resolve();
    expect(t.calls).toEqual(['start teams screen=false', 'start teams screen=true', 'add teams']);
  });

  it('ignores an answer for a meeting that is gone', async () => {
    const t = setup();
    const meeting = t.detector.begin('meet');
    t.detector.end(meeting.meetingId);
    t.service.respond(meeting.meetingId, 'record');
    await Promise.resolve();
    expect(t.calls).toEqual([]);
  });

  it('closes the prompt when its meeting ends and tells the subscribers', () => {
    const t = setup();
    const ended: string[] = [];
    t.service.onMeetingEnded((id) => ended.push(id));
    const meeting = t.detector.begin('meet');
    t.detector.end(meeting.meetingId);
    expect(t.closed).toContain(meeting.meetingId);
    expect(ended).toEqual([meeting.meetingId]);
    expect(t.service.list().meetings).toEqual([]);
  });

  it('passes shares on to subscribers and publishes the list', () => {
    const t = setup();
    const meeting = t.detector.begin('meet');
    const seen: string[] = [];
    t.service.onShareStarted((id, kind) => seen.push(`start ${id} ${kind}`));
    t.service.onShareEnded((id) => seen.push(`end ${id}`));
    meeting.sharing = true;
    t.detector.listener?.({
      type: 'shareStarted',
      meetingId: meeting.meetingId,
      kind: 'screen',
      indicatorRect: { x: 0, y: 0, width: 1, height: 1 },
    });
    t.detector.listener?.({ type: 'shareEnded', meetingId: meeting.meetingId });
    expect(seen).toEqual([`start ${meeting.meetingId} screen`, `end ${meeting.meetingId}`]);
    expect(t.published.at(-1)?.meetings[0]).toMatchObject({ app: 'meet', appLabel: 'Google Meet' });
  });

  it('starts the detector only when detection is on, and follows the setting', () => {
    const off = setup({ detect: false });
    off.service.start();
    expect(off.detector.running).toBe(false);
    const t = setup();
    t.service.start();
    expect(t.detector.running).toBe(true);
  });
});
