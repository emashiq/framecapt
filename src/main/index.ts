import path from 'node:path';
import { app, BrowserWindow, Menu, nativeTheme, session } from 'electron';
import { createCaptureProvider } from './capture';
import { registerHandlers } from './handlers';
import { initLogger, log } from './logger';
import { installCsp, installNavigationLockdown, installPermissionHandlers } from './security';
import { handleSquirrelEvent } from './squirrel';
import { createMainWindow, getMainWindow, getOriginConfig } from './windows';

// PROVISIONAL app id - owner must confirm before publication (also set in forge.config.ts).
const APP_USER_MODEL_ID = 'com.framelet.app';

// Installer lifecycle launches are handled without starting the UI.
if (!handleSquirrelEvent()) {
  start();
}

function start(): void {
  // Tests point userData at a temp dir. Never honored by packaged builds.
  const overrideDir = process.env.FRAMELET_USER_DATA_DIR;
  if (!app.isPackaged && overrideDir) {
    app.setPath('userData', path.resolve(overrideDir));
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  installNavigationLockdown(getOriginConfig);

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  void app.whenReady().then(async () => {
    const logger = initLogger(path.join(app.getPath('userData'), 'logs'));
    logger.info(`Framelet ${app.getVersion()} starting (electron ${process.versions.electron})`);

    process.on('uncaughtException', (error) => log.error('uncaughtException', error));
    process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));

    if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
    nativeTheme.themeSource = 'system';
    nativeTheme.on('updated', () => {
      getMainWindow()?.webContents.send('app:themeChanged', {
        dark: nativeTheme.shouldUseDarkColors,
      });
    });
    if (app.isPackaged) Menu.setApplicationMenu(null);

    installCsp(session.defaultSession, getOriginConfig());
    installPermissionHandlers(session.defaultSession, getOriginConfig);
    registerHandlers(await createCaptureProvider());
    createMainWindow();
  });
}
