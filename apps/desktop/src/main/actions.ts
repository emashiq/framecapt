import type { RecorderStartRequest } from '../shared/recorder-ipc';
import type { RecorderStatus } from '../shared/recorder-machine';
import { recordOptionsFromSettings, type Settings } from '../shared/settings';
import type { StartRequestEvent, ToastEvent } from '../shared/settings-ipc';
import type { ShortcutAction } from '../shared/shortcuts';
import type { StartScreenshotRequest } from '../shared/shot-ipc';
import { friendlyError } from '../shared/error-messages';

/** What the actions need from the app (Electron-free so the routing is unit tested). */
export interface ActionDeps {
  settings: () => Settings;
  recorder: {
    status: RecorderStatus;
    busy: boolean;
    start: (request: RecorderStartRequest) => Promise<unknown>;
    stop: () => Promise<void>;
    pause: () => void;
    resume: () => void;
    cancel: () => void;
  };
  screenshotBusy: () => boolean;
  startScreenshot: (request: StartScreenshotRequest) => Promise<void>;
  /** The editor holds a screenshot (and whether leaving it would lose work). */
  editor: () => { open: boolean; dirty: boolean };
  /** Shows the main window and tells its renderer to start something (it asks first when needed). */
  askMain: (request: StartRequestEvent) => void;
  toast: (event: ToastEvent) => void;
  log: { info: (message: string) => void };
}

const SCREENSHOT_TARGETS = {
  screenshotScreen: { target: 'screen' },
  screenshotWindow: { target: 'window' },
  screenshotRegion: { target: 'region' },
  screenshotAllScreens: { target: 'screen', allScreens: true },
} as const satisfies Record<string, StartScreenshotRequest>;
const RECORD_TARGETS = {
  recordScreen: 'screen',
  recordWindow: 'window',
  recordRegion: 'region',
} as const;

const PRE_RECORDING: readonly RecorderStatus[] = [
  'selecting',
  'preflight',
  'countdown',
  'starting',
];

function errorToast(error: unknown): ToastEvent {
  const failure = error as { code?: string; message?: string };
  return { level: 'error', message: friendlyError(failure.code, failure.message) };
}

/**
 * The one place global shortcuts, the tray menu and (through the same functions) the buttons start
 * things. Rules: a screenshot while anything runs is refused (BUSY, said in the UI), except while a
 * recording is live: then screen and region screenshots are saved directly and a window one is
 * refused (its picker needs the main window, which must stay out of the video); a record
 * shortcut while recording stops it; pause toggles; window targets and an open editor go through
 * the main window, which needs a picker or the "discard this screenshot?" question.
 */
export function createActions(deps: ActionDeps): { run: (action: ShortcutAction) => void } {
  const busyToast = (): void =>
    deps.toast({ level: 'info', message: 'A capture is already in progress.' });

  function screenshot(request: StartScreenshotRequest): void {
    const { status } = deps.recorder;
    const live = status === 'recording' || status === 'paused';
    if ((deps.recorder.busy && !live) || deps.screenshotBusy()) return busyToast();
    if (live) {
      if (request.target === 'window') {
        return deps.toast({
          level: 'error',
          message:
            "Window screenshots can't be taken while recording. Use the camera button on the recording toolbar instead.",
        });
      }
    } else if (request.target === 'window' || deps.editor().dirty) {
      return deps.askMain({ kind: 'screenshot', ...request });
    }
    void deps.startScreenshot(request).catch((error: unknown) => deps.toast(errorToast(error)));
  }

  function record(target: Exclude<RecorderStartRequest['target'], 'multi'>): void {
    const { status } = deps.recorder;
    if (status === 'recording' || status === 'paused') {
      deps.log.info('Record shortcut pressed while recording: stopping');
      void deps.recorder.stop();
      return;
    }
    if (PRE_RECORDING.includes(status)) return deps.recorder.cancel();
    if (status === 'stopping' || status === 'processing' || deps.screenshotBusy()) {
      return busyToast();
    }
    if (target === 'window' || deps.editor().open) {
      return deps.askMain({ kind: 'record', target });
    }
    void deps.recorder
      .start({ target, options: recordOptionsFromSettings(deps.settings().recording) })
      .catch((error: unknown) => deps.toast(errorToast(error)));
  }

  return {
    run(action) {
      if (action in SCREENSHOT_TARGETS) {
        return screenshot(SCREENSHOT_TARGETS[action as keyof typeof SCREENSHOT_TARGETS]);
      }
      if (action in RECORD_TARGETS) {
        return record(RECORD_TARGETS[action as keyof typeof RECORD_TARGETS]);
      }
      const { status } = deps.recorder;
      if (action === 'stopRecording') {
        if (status === 'recording' || status === 'paused') void deps.recorder.stop();
        else if (PRE_RECORDING.includes(status)) deps.recorder.cancel();
        return;
      }
      if (action === 'pauseRecording') {
        if (status === 'recording') deps.recorder.pause();
        else if (status === 'paused') deps.recorder.resume();
      }
    },
  };
}
