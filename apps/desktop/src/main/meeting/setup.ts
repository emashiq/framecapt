import { Notification } from 'electron';
import { sendEvent } from '../events';
import { handle } from '../ipc';
import { log } from '../logger';
import { createWindowProbe } from '../platform/create-probe';
import type { SettingsStore } from '../settings/store';
import { getMainWindow, isQuitting, webContentsWithRoles } from '../windows';
import { MeetingDetector } from './detector';
import { MeetingPromptWindow } from './prompt-window';
import { MeetingService, type MeetingActions } from './service';

/** Build-time constant of vite.main.config.ts: the literal `false` in every normal build. */
declare const __FRAMECAPT_E2E__: boolean;

export interface MeetingsOptions {
  store: SettingsStore;
  /** A recording is running right now (the recorder's `isLive`). */
  recordingLive: () => boolean;
  /** What the prompt's buttons do; Phase 6 passes the recorder-backed implementation. */
  actions?: MeetingActions;
}

export interface Meetings {
  service: MeetingService;
  dispose(): void;
}

/** Until meeting recording exists the buttons only say so. */
const PENDING_MESSAGE = 'Meeting recording arrives in the next update';

function tellPending(): void {
  if (getMainWindow()?.isVisible()) {
    for (const contents of webContentsWithRoles(['main'])) {
      sendEvent(contents, 'app:toast', { level: 'info', message: PENDING_MESSAGE });
    }
  } else if (Notification.isSupported()) {
    new Notification({ title: 'FrameCapt', body: PENDING_MESSAGE, silent: true }).show();
  }
}

const pendingActions: MeetingActions = {
  startMeetingRecording: () => {
    log.info('meeting recording is not implemented yet');
    tellPending();
  },
  addMeetingToRecording: () => {
    log.info('adding a meeting to a recording is not implemented yet');
    tellPending();
  },
};

/**
 * Meeting detection for the app: a window probe, the detector, the prompt window and its IPC.
 * Returns null (a no-op) off Windows and Linux or when no probe could be created.
 */
export async function setupMeetings(options: MeetingsOptions): Promise<Meetings | null> {
  if (process.platform !== 'win32' && process.platform !== 'linux') return null;
  const { store } = options;
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
    actions: options.actions ?? pendingActions,
    recordingLive: options.recordingLive,
    publish: (list) => {
      for (const contents of webContentsWithRoles(['main'])) {
        sendEvent(contents, 'meeting:state', list);
      }
    },
    log: (message) => log.info(message),
  });

  handle('meeting:respond', { roles: ['meeting-prompt'] }, (request) =>
    service.respond(request.meetingId, request.action),
  );
  handle('meeting:getPrompt', { roles: ['meeting-prompt'] }, () => prompt.current());
  handle('meeting:list', { roles: ['main'] }, () => service.list());

  if (__FRAMECAPT_E2E__) {
    (globalThis as Record<string, unknown>).__frameCaptMeetings = {
      poll: () => detector.poll(),
      list: () => service.list(),
    };
  }

  service.start();
  return {
    service,
    dispose() {
      service.stop();
      probe.dispose();
    },
  };
}
