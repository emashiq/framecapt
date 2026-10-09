import type { Rect } from '../../shared/rect';
import type {
  MeetingList,
  MeetingPromptAction,
  MeetingPromptEvent,
} from '../../shared/meeting-ipc';
import { MEETING_APP_LABELS, type MeetingApp } from '../../shared/meeting-signatures';
import type { Settings } from '../../shared/settings';
import type { WinInfo } from '../platform/window-probe';
import type { MeetingDetectorEvent, MeetingInfo } from './detector';

/** What the prompt's buttons do. Phase 6 plugs the recorder in here. */
export interface MeetingActions {
  startMeetingRecording(
    meeting: MeetingInfo,
    options: { withScreen: boolean },
  ): void | Promise<void>;
  addMeetingToRecording(meeting: MeetingInfo): void | Promise<void>;
}

/** The prompt window as the service sees it. */
export interface MeetingPromptPort {
  show(event: MeetingPromptEvent, timeoutMs: number): void;
  /** Closes the prompt; with an id, only if it shows that meeting. */
  close(meetingId?: string): void;
}

/** The detector as the service sees it. */
export interface DetectorPort {
  onEvent(listener: (event: MeetingDetectorEvent) => void): () => void;
  start(): void;
  stop(): void;
  current(): MeetingInfo[];
  getWindow(hwnd: string): Promise<WinInfo | null>;
}

export interface MeetingServiceDeps {
  detector: DetectorPort;
  settings: {
    get(): Settings['meetings'];
    update(patch: Partial<Settings['meetings']>): void;
    onChange(listener: (meetings: Settings['meetings']) => void): void;
  };
  prompt: MeetingPromptPort;
  actions: MeetingActions;
  recordingLive(): boolean;
  /** The meeting list changed (pushed to the main window). */
  publish(list: MeetingList): void;
  log(message: string): void;
}

/**
 * Meeting detection as the app uses it: the detector, the prompt and the settings. Each meeting is
 * prompted once; the answer is a settings change (Don't ask for) or an action Phase 6 implements.
 */
export class MeetingService {
  private readonly prompted = new Set<string>();
  private readonly shareStartedListeners = new Set<
    (meetingId: string, kind: 'screen' | 'window', indicatorRect: Rect) => void
  >();
  private readonly shareEndedListeners = new Set<(meetingId: string) => void>();
  private readonly endedListeners = new Set<(meetingId: string) => void>();

  constructor(private readonly deps: MeetingServiceDeps) {
    deps.detector.onEvent((event) => this.handle(event));
    deps.settings.onChange((meetings) => {
      if (meetings.detect) deps.detector.start();
      else deps.detector.stop();
    });
  }

  /** Starts watching when the setting is on. */
  start(): void {
    if (this.deps.settings.get().detect) this.deps.detector.start();
  }

  stop(): void {
    this.deps.detector.stop();
    this.deps.prompt.close();
  }

  list(): MeetingList {
    return {
      meetings: this.deps.detector.current().map((meeting) => ({
        meetingId: meeting.meetingId,
        app: meeting.app,
        appLabel: MEETING_APP_LABELS[meeting.app],
        sharing: meeting.sharing,
      })),
    };
  }

  /** A meeting being watched, with the window facts the list leaves out. */
  find(meetingId: string): MeetingInfo | undefined {
    return this.deps.detector.current().find((meeting) => meeting.meetingId === meetingId);
  }

  getWindow(hwnd: string): Promise<WinInfo | null> {
    return this.deps.detector.getWindow(hwnd);
  }

  onShareStarted(
    listener: (meetingId: string, kind: 'screen' | 'window', indicatorRect: Rect) => void,
  ): () => void {
    this.shareStartedListeners.add(listener);
    return () => this.shareStartedListeners.delete(listener);
  }

  onShareEnded(listener: (meetingId: string) => void): () => void {
    this.shareEndedListeners.add(listener);
    return () => this.shareEndedListeners.delete(listener);
  }

  onMeetingEnded(listener: (meetingId: string) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  /** The user's answer on the prompt. */
  respond(meetingId: string, action: MeetingPromptAction): void {
    this.deps.prompt.close(meetingId);
    const meeting = this.deps.detector.current().find((m) => m.meetingId === meetingId);
    if (!meeting) return;
    this.deps.log(`meeting prompt: ${action} (${meeting.app})`);
    switch (action) {
      case 'dismiss':
        return;
      case 'mute-app':
        this.mute(meeting.app);
        return;
      case 'record':
      case 'record-with-screen':
        this.run(() =>
          this.deps.actions.startMeetingRecording(meeting, {
            withScreen: action === 'record-with-screen',
          }),
        );
        return;
      case 'add-to-recording':
        this.run(() => this.deps.actions.addMeetingToRecording(meeting));
        return;
    }
  }

  private mute(app: MeetingApp): void {
    const { mutedApps } = this.deps.settings.get();
    if (!mutedApps.includes(app)) this.deps.settings.update({ mutedApps: [...mutedApps, app] });
  }

  private run(action: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) =>
        this.deps.log(`meeting action failed: ${error instanceof Error ? error.message : 'error'}`),
      );
  }

  private handle(event: MeetingDetectorEvent): void {
    switch (event.type) {
      case 'meetingStarted':
        this.deps.publish(this.list());
        this.maybePrompt(event.meeting);
        return;
      case 'meetingEnded':
        this.prompted.delete(event.meetingId);
        this.deps.prompt.close(event.meetingId);
        this.deps.publish(this.list());
        for (const listener of this.endedListeners) listener(event.meetingId);
        return;
      case 'shareStarted':
        this.deps.publish(this.list());
        for (const listener of this.shareStartedListeners) {
          listener(event.meetingId, event.kind, event.indicatorRect);
        }
        return;
      case 'shareEnded':
        this.deps.publish(this.list());
        for (const listener of this.shareEndedListeners) listener(event.meetingId);
        return;
    }
  }

  /** Each meeting is offered once (a dismissed or timed-out prompt does not come back). */
  private maybePrompt(meeting: MeetingInfo): void {
    const config = this.deps.settings.get();
    if (!config.detect || !config.apps[meeting.app] || config.mutedApps.includes(meeting.app))
      return;
    if (this.prompted.has(meeting.meetingId)) return;
    this.prompted.add(meeting.meetingId);
    this.deps.prompt.show(
      {
        meetingId: meeting.meetingId,
        app: meeting.app,
        appLabel: MEETING_APP_LABELS[meeting.app],
        recordingLive: this.deps.recordingLive(),
      },
      config.promptTimeoutSec * 1000,
    );
  }
}
