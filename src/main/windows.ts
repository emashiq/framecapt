import path from 'node:path';
import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron';
import type { AppOriginConfig } from './app-origin';
import type { Role } from '../shared/types';
import { CloseGuard } from './close-guard';
import { sendEvent } from './events';

/** Window backgrounds matching --color-bg in styles.css, so there is no white flash. */
const BACKGROUND = { light: '#f8fafc', dark: '#0b0f1a' } as const;

/** One renderer entry serves every role; the role is picked by location hash (see main.tsx). */
const ROLE_HASH: Record<Role, string> = {
  main: '/',
  overlay: '/overlay',
  toolbar: '/toolbar',
  recorder: '/recorder',
};

const roles = new Map<number, Role>();
let mainWindow: BrowserWindow | undefined;

/** Asks before the main window closes over unsaved editor work (see close-guard.ts). */
export const closeGuard = new CloseGuard();
const mainClosedListeners: (() => void)[] = [];

/** Runs when the main window is gone (the editor's session directory is deleted then). */
export function onMainWindowClosed(listener: () => void): void {
  mainClosedListeners.push(listener);
}

/** Registers a webContents under a role; removed again when it is destroyed. */
export function registerWebContents(contents: WebContents, role: Role): void {
  const id = contents.id;
  roles.set(id, role);
  contents.once('destroyed', () => roles.delete(id));
}

export function getRole(webContentsId: number): Role | undefined {
  return roles.get(webContentsId);
}

export function getMainWindow(): BrowserWindow | undefined {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

/** Origin policy shared by navigation lockdown, permission handlers and IPC sender checks. */
export function getOriginConfig(): AppOriginConfig {
  return {
    devServerUrl:
      typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' && MAIN_WINDOW_VITE_DEV_SERVER_URL
        ? MAIN_WINDOW_VITE_DEV_SERVER_URL
        : undefined,
    rendererDir: path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME),
  };
}

/** The secure renderer settings every Framelet window uses. */
export function securePreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    webviewTag: false,
    allowRunningInsecureContent: false,
    devTools: !app.isPackaged,
  };
}

export function loadRenderer(win: BrowserWindow, role: Role): Promise<void> {
  const { devServerUrl, rendererDir } = getOriginConfig();
  const hash = ROLE_HASH[role];
  if (devServerUrl) return win.loadURL(`${devServerUrl}#${hash}`);
  return win.loadFile(path.join(rendererDir, 'index.html'), { hash });
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Framelet',
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    webPreferences: securePreferences(),
  });

  registerWebContents(win.webContents, 'main');
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (win.webContents.isDestroyed() || closeGuard.onCloseRequested() === 'close') return;
    event.preventDefault();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendEvent(win.webContents, 'app:confirmClose', {});
  });
  // A logoff or shutdown must never wait for the discard question.
  win.on('session-end', () => closeGuard.allowClose());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
    for (const listener of mainClosedListeners) listener();
    // The hidden worker would otherwise keep the app alive after the main window is closed.
    closeWorkerWindow();
  });

  void loadRenderer(win, 'main');
  return win;
}

let workerWindow: BrowserWindow | undefined;

/**
 * The capture worker: one hidden 'recorder' window, created on first use. It runs the renderer's
 * capture code (getDisplayMedia, frame grabs) without ever being shown. Phase 05 makes the same
 * window own the recorder. `backgroundThrottling: false` keeps frame delivery and timers running
 * while the window is hidden.
 */
export function getWorkerWindow(): BrowserWindow {
  if (workerWindow && !workerWindow.isDestroyed()) return workerWindow;
  const win = new BrowserWindow({
    title: 'Framelet capture worker',
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    webPreferences: { ...securePreferences(), backgroundThrottling: false },
  });
  registerWebContents(win.webContents, 'recorder');
  workerWindow = win;
  win.on('closed', () => {
    if (workerWindow === win) workerWindow = undefined;
  });
  void loadRenderer(win, 'recorder');
  return win;
}

export function closeWorkerWindow(): void {
  const win = workerWindow;
  workerWindow = undefined;
  if (win && !win.isDestroyed()) win.destroy();
}
