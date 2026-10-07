import {
  app,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  screen,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import type { ShortcutAction, ShortcutStates } from '../shared/shortcuts';
import type { Settings } from '../shared/settings';
import { createActions } from './actions';
import type { AppServices } from './handlers';
import { sendEvent } from './events';
import { handle, ipcCallCount } from './ipc';
import { log } from './logger';
import type { AppSettings } from './settings';
import { registerSettingsHandlers } from './settings/handlers';
import { hasProblems, ShortcutManager, type GlobalShortcutApi } from './shortcuts';
import { TrayController, buildTrayTemplate, trayTooltip, type TrayState } from './tray';
import { TRAY_ICONS, TRAY_SCALE_FACTORS } from './tray-icons.generated';
import type { TrayInfo } from './tray-info';
import {
  getMainWindow,
  setCloseToTrayPolicy,
  showMainWindow,
  webContentsWithRoles,
} from './windows';

/** Build-time constant of vite.main.config.ts: the literal `false` in every normal build. */
declare const __FRAMECAPT_E2E__: boolean;

export interface Desktop {
  tray: TrayController;
  shortcuts: ShortcutManager;
  trayInfo(): TrayInfo;
  /** Quit from the tray or a menu: asks first while a recording runs. */
  requestQuit(): void;
  dispose(): void;
}

function trayImage(variant: 'normal' | 'recording') {
  const image = nativeImage.createEmpty();
  // 16, 20, 24 and 32 px for 100, 125, 150 and 200 % display scaling.
  for (const size of [16, 20, 24, 32] as const) {
    image.addRepresentation({
      scaleFactor: TRAY_SCALE_FACTORS[size],
      width: size,
      height: size,
      buffer: Buffer.from(TRAY_ICONS[variant][size], 'base64'),
    });
  }
  return image;
}

/**
 * E2E builds only (FRAMECAPT_E2E_FAKE_SHORTCUTS=1): a stand-in for `globalShortcut` so the suite
 * never grabs real system-wide keys. `FRAMECAPT_E2E_TAKEN_SHORTCUTS` ("A,B") lists accelerators that
 * "another app" holds: registering them fails like it does on Windows.
 */
function fakeGlobalShortcut(): GlobalShortcutApi & { held: Set<string> } {
  const taken = new Set(
    (process.env.FRAMECAPT_E2E_TAKEN_SHORTCUTS ?? '').split(',').filter((value) => value !== ''),
  );
  const held = new Set<string>();
  return {
    held,
    register: (accelerator) => {
      if (taken.has(accelerator) || held.has(accelerator)) return false;
      held.add(accelerator);
      return true;
    },
    unregister: (accelerator) => {
      held.delete(accelerator);
    },
  };
}

/**
 * The desktop layer: global shortcuts, the tray icon, close-to-tray and quitting. Everything here
 * routes into the same flow functions the buttons use (see actions.ts), so there is one way to
 * start a capture or a recording.
 */
export function setupDesktop(settings: AppSettings, services: AppServices): Desktop {
  const { store } = settings;
  const { recorder, flow, steps } = services;
  const toMain = <E extends Parameters<typeof sendEvent>[1]>(
    event: E,
    payload: Parameters<typeof sendEvent<E>>[2],
  ): void => {
    for (const contents of webContentsWithRoles(['main'])) sendEvent(contents, event, payload);
  };

  /** Settings and shortcut states are shown by the main window and the Editor window. */
  const toWindows = <E extends 'settings:changed' | 'shortcuts:changed'>(
    event: E,
    payload: Parameters<typeof sendEvent<E>>[2],
  ): void => {
    for (const contents of webContentsWithRoles(['main', 'editor']))
      sendEvent(contents, event, payload);
  };

  const actions = createActions({
    settings: () => store.get(),
    recorder: {
      get status() {
        return recorder.status;
      },
      get busy() {
        return recorder.busy;
      },
      start: (request) => recorder.start(request),
      stop: () => recorder.stop('user'),
      pause: () => recorder.pause(),
      resume: () => recorder.resume(),
      cancel: () => recorder.cancel(),
    },
    screenshotBusy: () => flow.state.active,
    steps: {
      get active() {
        return steps.active;
      },
      start: () => steps.start(),
      done: () => steps.done(),
      captureStep: () => steps.captureStep(),
    },
    startScreenshot: (request) => flow.start(request),
    askMain: (request) => {
      showMainWindow();
      toMain('app:startRequest', request);
    },
    toast: (event) => {
      if (getMainWindow()?.isVisible()) toMain('app:toast', event);
      else if (event.level === 'error') notify('FrameCapt', event.message);
    },
    log,
  });

  // --- global shortcuts ---------------------------------------------------------------------

  const fake = __FRAMECAPT_E2E__ && process.env.FRAMECAPT_E2E_FAKE_SHORTCUTS === '1';
  const fakeApi = fake ? fakeGlobalShortcut() : undefined;
  const shortcuts = new ShortcutManager({
    api: fakeApi ?? {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    run: (action) => {
      log.info(`Shortcut: ${action}`);
      actions.run(action);
    },
    log,
  });
  shortcuts.onStatus((states) => toWindows('shortcuts:changed', states));
  const states = shortcuts.apply(store.get().shortcuts);
  if (hasProblems(states)) {
    log.warn('Some shortcuts could not be registered; see Settings > Shortcuts');
    notify('Some shortcuts are unavailable', 'Open Settings → Shortcuts to choose different ones.');
  }

  // --- notifications ------------------------------------------------------------------------

  function notify(title: string, body: string): void {
    if (!store.get().general.showNotifications || !Notification.isSupported()) return;
    try {
      new Notification({ title, body, silent: true }).show();
    } catch (error) {
      log.warn(`Notification failed: ${String(error)}`);
    }
  }

  // --- tray ---------------------------------------------------------------------------------

  function openView(view: 'history' | 'settings'): void {
    showMainWindow();
    toMain('app:navigate', { view });
  }

  function requestQuit(): void {
    if (recorder.isRecording && !recorder.isQuitting) {
      showMainWindow();
      toMain('app:confirmQuit', {});
      return;
    }
    app.quit();
  }

  const tray = new TrayController({
    createTray: (image) => new Tray(image),
    buildMenu: (template) => Menu.buildFromTemplate(template),
    icons: { normal: trayImage('normal'), recording: trayImage('recording') },
    handlers: {
      open: () => void showMainWindow(),
      openView,
      run: (action: ShortcutAction) => actions.run(action),
      togglePause: () => actions.run('pauseRecording'),
      stop: () => actions.run('stopRecording'),
      quit: requestQuit,
    },
    log,
  });

  const trayState = (): TrayState => {
    const snapshot = recorder.snapshot();
    const active =
      snapshot.activeMs + (snapshot.runningSince === null ? 0 : Date.now() - snapshot.runningSince);
    return {
      status: snapshot.status,
      activeMs: active,
      shortcuts: shortcuts.status(),
      screenshotBusy: flow.state.active || steps.active,
      stepsActive: steps.active,
      multiDisplay: screen.getAllDisplays().length > 1,
    };
  };
  let clock: NodeJS.Timeout | undefined;
  const refreshTray = (): void => {
    const state = trayState();
    tray.update(state);
    // The tooltip clock ticks only while a recording runs: nothing runs while idle.
    if (state.status === 'recording' && !clock) {
      clock = setInterval(() => tray.updateTooltip(trayState()), 1000);
    } else if (state.status !== 'recording' && clock) {
      clearInterval(clock);
      clock = undefined;
    }
  };
  tray.ensure();
  refreshTray();
  recorder.onChange(refreshTray);
  steps.onChange(refreshTray);
  // "All screens" in the menu follows the connected displays.
  screen.on('display-added', refreshTray);
  screen.on('display-removed', refreshTray);
  shortcuts.onStatus(refreshTray);

  // --- close to tray ------------------------------------------------------------------------

  setCloseToTrayPolicy(
    () => store.get().general.closeToTray && tray.active,
    () => {
      if (store.get().notices.trayHintShown) return;
      if (!store.get().general.showNotifications) return;
      notify(
        'FrameCapt is still running in the tray',
        'Click the tray icon to open it again, or choose Quit to exit.',
      );
      store.markTrayHintShown();
    },
  );

  // --- settings changes ---------------------------------------------------------------------

  let lastShortcuts = JSON.stringify(store.get().shortcuts);
  store.onChange((next: Settings) => {
    const serialized = JSON.stringify(next.shortcuts);
    if (serialized !== lastShortcuts) {
      lastShortcuts = serialized;
      shortcuts.apply(next.shortcuts);
    }
    toWindows('settings:changed', { settings: next, effective: settings.dirs() });
  });

  registerSettingsHandlers(settings, shortcuts);
  handle('app:requestQuit', { roles: ['main'] }, () => requestQuit());
  handle('app:resolveQuit', { roles: ['main'] }, (request) => {
    if (request.stop) app.quit();
  });

  // --- test hooks (E2E builds only) ---------------------------------------------------------

  if (__FRAMECAPT_E2E__) {
    (globalThis as Record<string, unknown>).__frameCaptTest = {
      trayInstances: () => tray.instances,
      trayActive: () => tray.active,
      heldShortcuts: () => fakeApi?.held ?? new Set<string>(),
      shortcutStates: (): ShortcutStates => shortcuts.status(),
      runAction: (action: ShortcutAction) => actions.run(action),
      openFromTray: () => void showMainWindow(),
      destroyMainWindow: () => getMainWindow()?.destroy(),
      requestQuit,
      /** The tray menu as {label, enabled, accelerator} (submenus nested). */
      trayMenu: () => {
        const flat = (items: MenuItemConstructorOptions[]): unknown[] =>
          items.map((item) => ({
            label: item.label ?? '-',
            enabled: item.enabled ?? true,
            accelerator: item.accelerator,
            ...(Array.isArray(item.submenu) && { submenu: flat(item.submenu) }),
          }));
        return flat(buildTrayTemplate(trayState(), tray.handlersForTest));
      },
      trayTooltip: () => trayTooltip(trayState()),
      stepsState: () => steps.snapshot(),
      ipcTotal: () => ipcCallCount(),
      ipcCount: (channel: string) => ipcCallCount(channel),
    };
  }

  return {
    tray,
    shortcuts,
    trayInfo: () => ({ active: tray.active, bounds: tray.bounds() }),
    requestQuit,
    dispose() {
      if (clock) clearInterval(clock);
      shortcuts.dispose();
      tray.destroy();
    },
  };
}
