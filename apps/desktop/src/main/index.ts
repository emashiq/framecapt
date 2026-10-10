import path from 'node:path';
import { app, autoUpdater, BrowserWindow, Menu, nativeTheme, session } from 'electron';
import { createCaptureProvider } from './capture';
import { registerAppProtocol, registerPrivilegedSchemes } from './app-protocol';
import { setupDesktop, type Desktop } from './desktop';
import { registerHandlers } from './handlers';
import { applyLinuxSwitches } from './linux';
import { setupMeetings, type Meetings } from './meeting/setup';
import { initLogger, log } from './logger';
import {
  installCsp,
  installNavigationLockdown,
  disableSpellChecker,
  installNetworkBlocker,
  installPermissionHandlers,
} from './security';
import { createAppSettings, watchSettings } from './settings';
import { HIDDEN_ARG } from './settings/login-item';
import { SettingsStore, SETTINGS_FILE } from './settings/store';
import { appUserModelId, handleSquirrelEvent } from './squirrel';
import { isSquirrelInstall, UpdateService } from './updates';
import {
  createMainWindow,
  getMainWindow,
  getRole,
  getOriginConfig,
  getRendererDir,
  isQuitting,
  setQuitting,
  showMainWindow,
} from './windows';

// Installer lifecycle launches are handled without starting the UI.
if (!handleSquirrelEvent()) {
  start();
}

function start(): void {
  // Every renderer is sandboxed, including any window a future change forgets to configure.
  app.enableSandbox();
  // X11 (or XWayland) on Linux, before anything is ready: see linux.ts.
  applyLinuxSwitches(app.commandLine);
  // No spellchecker (no dictionary download from Google) on any platform: see security.ts.
  app.commandLine.appendSwitch('disable-spell-checking');
  // Privileged schemes must be registered before the app is ready.
  registerPrivilegedSchemes();

  // Tests point userData at a temp dir. Never honored by packaged builds.
  const overrideDir = process.env.FRAMECAPT_USER_DATA_DIR;
  if (!app.isPackaged && overrideDir) {
    app.setPath('userData', path.resolve(overrideDir));
    // Keep the default save location inside the test directory as well.
    app.setPath('pictures', path.join(path.resolve(overrideDir), 'pictures'));
    app.setPath('videos', path.join(path.resolve(overrideDir), 'videos'));
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // A second launch brings the first one forward (also out of the tray).
  app.on('second-instance', () => {
    showMainWindow();
  });

  installNavigationLockdown(getOriginConfig);

  let desktop: Desktop | undefined;
  let settings: SettingsStore | undefined;
  let meetings: Meetings | null = null;

  // From here on closing windows really closes them (close-to-tray stands down).
  app.on('before-quit', () => setQuitting(true));

  // With close-to-tray the app lives on in the tray after its last window is gone, unless the user
  // quit: a quit that the unsaved-work question stopped starts again once they discard.
  app.on('window-all-closed', () => {
    const keepAlive = settings?.get().general.closeToTray === true && desktop?.tray.active === true;
    if (!keepAlive || isQuitting()) app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  // Pending settings are written before the process ends; shortcuts and the tray are released.
  app.on('will-quit', (event) => {
    desktop?.dispose();
    meetings?.dispose();
    if (settings?.hasPendingWrite) {
      event.preventDefault();
      void settings.flush().finally(() => app.quit());
    }
  });

  void app.whenReady().then(async () => {
    const logger = initLogger(path.join(app.getPath('userData'), 'logs'));
    logger.info(`FrameCapt ${app.getVersion()} starting (electron ${process.versions.electron})`);

    process.on('uncaughtException', (error) => log.error('uncaughtException', error));
    process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));

    if (process.platform === 'win32') app.setAppUserModelId(appUserModelId(process.execPath));
    const store = new SettingsStore(path.join(app.getPath('userData'), SETTINGS_FILE));
    settings = store;
    await store.load();
    watchSettings(store);
    nativeTheme.on('updated', () => {
      getMainWindow()?.webContents.send('app:themeChanged', {
        dark: nativeTheme.shouldUseDarkColors,
      });
    });
    if (app.isPackaged) Menu.setApplicationMenu(null);

    // The production renderer is served from app://framecapt (dev uses the Vite server).
    registerAppProtocol(getRendererDir());
    installCsp(session.defaultSession, getOriginConfig());
    installPermissionHandlers(session.defaultSession, getOriginConfig, (contents) =>
      contents ? getRole(contents.id) : undefined,
    );
    installNetworkBlocker(session.defaultSession, getOriginConfig);
    disableSpellChecker(session.defaultSession);
    // Unconfigured (empty feed URL) builds never touch autoUpdater: no update code, no network.
    const updates = new UpdateService({
      feedUrl: __FRAMECAPT_UPDATE_URL__,
      getAutoUpdater: () => autoUpdater,
      isSquirrelInstall: () => isSquirrelInstall(process.execPath),
    });
    const appSettings = createAppSettings(store);
    const provider = await createCaptureProvider();
    const services = registerHandlers(
      provider,
      appSettings,
      () => desktop?.trayInfo() ?? { active: false, bounds: null },
      updates,
    );
    desktop = setupDesktop(appSettings, services);
    void setupMeetings({
      store,
      recordingLive: () => services.recorder.anyLive,
      recorder: services.recorder,
      provider,
    }).then((created) => {
      meetings = created;
      if (created) desktop?.setMeetings(created);
    });
    // A start at login (--hidden) lives in the tray; without a tray the window is the only UI.
    const hidden = process.argv.includes(HIDDEN_ARG) && desktop.tray.active;
    createMainWindow({ show: !hidden });
  });
}
