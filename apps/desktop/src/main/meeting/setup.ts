import { Notification, screen } from 'electron';
import type { MeetingList } from '../../shared/meeting-ipc';
import type { CaptureProvider } from '../capture/types';
import { sendEvent } from '../events';
import { handle } from '../ipc';
import { log } from '../logger';
import { createWindowProbe } from '../platform/create-probe';
import type { RecorderController } from '../recorder/controller';
import type { SettingsStore } from '../settings/store';
import { getMainWindow, isQuitting, webContentsWithRoles } from '../windows';
import { MeetingDetector } from './detector';
import { MeetingRecorder } from './meeting-recorder';
import { MeetingPromptWindow } from './prompt-window';
import { MeetingService, type MeetingActions } from './service';
import { WATCH_POLL_MS } from './visibility';

/** Build-time constant of vite.main.config.ts: the literal `false` in every normal build. */
declare const __FRAMECAPT_E2E__: boolean;

export interface MeetingsOptions {
  store: SettingsStore;
  /** A recording is running right now (the recorder's `isLive`). */
  recordingLive: () => boolean;
  recorder: RecorderController;
  provider: CaptureProvider;
}

export interface Meetings {
  service: MeetingService;
  /** The meetings being watched changed (the tray lists them). */
  onChange(listener: () => void): () => void;
  /** Records a detected meeting alone (the tray's item). */
  record(meetingId: string): void;
  dispose(): void;
}

/** Tells the user something: the main window, else a recording's toolbar, else a notification. */
function tell(recorder: RecorderController, message: string): void {
  if (getMainWindow()?.isVisible()) {
    for (const contents of webContentsWithRoles(['main'])) {
      sendEvent(contents, 'app:toast', { level: 'info', message });
    }
  } else if (recorder.anyLive) {
    recorder.toastToolbar({ level: 'info', message });
  } else if (Notification.isSupported()) {
    new Notification({ title: 'FrameCapt', body: message, silent: true }).show();
  }
}

/**
 * Meeting detection for the app: a window probe, the detector, the prompt window and its IPC.
 * Returns null (a no-op) off Windows and Linux or when no probe could be created.
 */
export async function setupMeetings(options: MeetingsOptions): Promise<Meetings | null> {
  if (process.platform !== 'win32' && process.platform !== 'linux') return null;
  const { store, recorder, provider } = options;
  let probe;
  try {
    probe = await createWindowProbe();
  } catch (error) {
    log.warn(`meeting detection unavailable: ${error instanceof Error ? error.message : 'error'}`);
    return null;
  }
  // E2E builds only: a short poll so tests need not wait seconds for a meeting to be confirmed.
  const pollMs = __FRAMECAPT_E2E__ ? Number(process.env.FRAMECAPT_E2E_MEETING_POLL_MS) : NaN;
  const detector = new MeetingDetector({
    probe,
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handleToClear) => clearInterval(handleToClear as NodeJS.Timeout),
    settings: () => store.get().meetings,
    isQuitting,
    ...(Number.isFinite(pollMs) && pollMs > 0 && { intervalMs: pollMs }),
    log: (message) => log.info(message),
  });
  const prompt = new MeetingPromptWindow();
  const listeners = new Set<() => void>();
  // The service needs its actions at construction, the recorder needs the service: bridged here.
  const bridge: { recorder?: MeetingRecorder } = {};
  const actions: MeetingActions = {
    startMeetingRecording: (meeting, startOptions) =>
      bridge.recorder?.startMeetingRecording(meeting, startOptions),
    addMeetingToRecording: (meeting) => bridge.recorder?.addMeetingToRecording(meeting),
  };
  const service = new MeetingService({
    detector,
    settings: {
      get: () => store.get().meetings,
      update: (patch) => void store.update({ meetings: patch }),
      onChange: (listener) => {
        store.onChange((settings) => listener(settings.meetings));
      },
    },
    prompt,
    actions,
    recordingLive: options.recordingLive,
    publish: (list: MeetingList) => {
      for (const contents of webContentsWithRoles(['main'])) {
        sendEvent(contents, 'meeting:state', list);
      }
      for (const listener of listeners) listener();
    },
    log: (message) => log.info(message),
  });

  // The meeting windows are looked at as often as a poll, at most every 500 ms (E2E: the short poll).
  const watchMs =
    Number.isFinite(pollMs) && pollMs > 0 ? Math.min(pollMs, WATCH_POLL_MS) : undefined;
  const recorderPort = new MeetingRecorder({
    recorder,
    meetings: service,
    settings: () => store.get(),
    displays: () => provider.listDisplays(),
    cursorDisplayId: () => String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),
    toast: (message) => tell(recorder, message),
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    },
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handleToClear) => clearInterval(handleToClear as NodeJS.Timeout),
    ...(watchMs !== undefined && { pollMs: watchMs }),
    log: (message) => log.info(message),
  });
  bridge.recorder = recorderPort;
  recorder.setMeetingStarter((request) => recorderPort.startFromRequest(request));

  handle('meeting:respond', { roles: ['meeting-prompt'] }, (request) =>
    service.respond(request.meetingId, request.action),
  );
  handle('meeting:getPrompt', { roles: ['meeting-prompt'] }, () => prompt.current());
  handle('meeting:list', { roles: ['main'] }, () => service.list());
  handle('meeting:record', { roles: ['main'] }, (request) =>
    recorderPort.recordById(request.meetingId, request.withScreen, request.displayId),
  );
  handle('meeting:addToRecording', { roles: ['main'] }, (request) =>
    recorderPort.addById(request.meetingId),
  );

  if (__FRAMECAPT_E2E__) {
    (globalThis as Record<string, unknown>).__frameCaptMeetings = {
      poll: () => detector.poll(),
      list: () => service.list(),
    };
  }

  service.start();
  return {
    service,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(meetingId) {
      void recorderPort.recordById(meetingId, false).catch((error: unknown) => {
        log.warn(`recording a meeting failed: ${error instanceof Error ? error.message : 'error'}`);
      });
    },
    dispose() {
      recorderPort.dispose();
      service.stop();
      probe.dispose();
    },
  };
}
