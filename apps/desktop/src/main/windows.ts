import path from 'node:path';
import { app, BrowserWindow, nativeTheme, webContents, type WebContents } from 'electron';
import { APP_ENTRY_URL } from './app-asset';
import type { AppOriginConfig } from './app-origin';
import type { Role } from '../shared/types';
import { CloseGuard } from './close-guard';
import { sendEvent } from './events';
import { hasTitleBarOverlay, titleBarOverlay, titleBarWindowOptions } from './title-bar';
import { windowIconFor } from './window-icon';

/** Window backgrounds matching --color-bg in styles.css, so there is no white flash. */
const BACKGROUND = { light: '#f8fafc', dark: '#0b0f1a' } as const;

/** One renderer entry serves every role; the role is picked by location hash (see main.tsx). */
const ROLE_HASH: Record<Role, string> = {
  main: '/',
  overlay: '/overlay',
  toolbar: '/toolbar',
  recorder: '/recorder',
  countdown: '/countdown',
  camera: '/camera',
  'meeting-prompt': '/meeting-prompt',
};

const roles = new Map<number, Role>();
let mainWindow: BrowserWindow | undefined;

/** Asks before the main window closes over unsaved editor tabs (see close-guard.ts). */
export const closeGuard = new CloseGuard();
const mainClosedListeners: (() => void)[] = [];

/** Runs when the main window is gone (the screenshot sessions its tabs held are deleted then). */
export function onMainWindowClosed(listener: () => void): void {
  mainClosedListeners.push(listener);
}

/** Registers a webContents under a role; removed again when it is destroyed. */
export function registerWebContents(contents: WebContents, role: Role): void {
  const id = contents.id;
  roles.set(id, role);
  contents.once('destroyed', () => roles.delete(id));
}

/** The focused window is FrameCapt's recording toolbar or camera bubble. */
export function isOwnUiFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  const role = focused && !focused.isDestroyed() ? roles.get(focused.webContents.id) : undefined;
  return role === 'toolbar' || role === 'camera';
}

export function getRole(webContentsId: number): Role | undefined {
  return roles.get(webContentsId);
}

/** The live webContents registered under any of `wanted` (e.g. every window that shows state). */
export function webContentsWithRoles(wanted: readonly Role[]): WebContents[] {
  const found: WebContents[] = [];
  for (const [id, role] of roles) {
    if (!wanted.includes(role)) continue;
    const contents = webContents.fromId(id);
    if (contents && !contents.isDestroyed()) found.push(contents);
  }
  return found;
}

let closeInterceptor: (() => boolean) | undefined;
let hideOnClose: (() => boolean) | undefined;
let onHiddenToTray: (() => void) | undefined;
let quitting = false;

/**
 * Close-to-tray: while `policy()` is true (the setting is on and the tray icon exists) closing the
 * main window only hides it. `hidden` runs after each such hide (the one-time "still running" hint).
 */
export function setCloseToTrayPolicy(policy: () => boolean, hidden: () => void): void {
  hideOnClose = policy;
  onHiddenToTray = hidden;
}

/** The app is really quitting (Quit in the tray or menu, the OS ending the session): windows may close. */
export function setQuitting(value: boolean): void {
  quitting = value;
}

export function isQuitting(): boolean {
  return quitting;
}

/** Whether the editor tabs hold unsaved work, reported by the main window's renderer. */
export function setEditorDirty(dirty: boolean): void {
  closeGuard.setDirty(dirty);
}

/** The answer to the "close with unsaved tabs?" question. Returns whether the window closes now. */
export function resolveClose(discard: boolean): boolean {
  if (!closeGuard.resolve(discard)) {
    // "Keep editing" also withdraws a quit that was waiting on this answer.
    quitting = false;
    return false;
  }
  getMainWindow()?.close();
  return true;
}

/**
 * While `interceptor()` is true (a recording is running) closing the main window only minimizes
 * it: the window owns nothing, but closing it would close the recorder window with it.
 */
export function setMainCloseInterceptor(interceptor: () => boolean): void {
  closeInterceptor = interceptor;
}

let mainProtected = false;

/** While a recording is live the main window is excluded from capture (it can be shown for a picker). */
export function setMainProtected(on: boolean): void {
  mainProtected = on;
  getMainWindow()?.setContentProtection(on);
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
  };
}

/** The directory of the built renderer (inside app.asar when packaged); served by app-protocol.ts. */
export function getRendererDir(): string {
  return path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME);
}

/** The secure renderer settings every FrameCapt window uses. */
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

/** `search` (for example `?mode=steps`) goes after the role's hash; the role itself is unchanged. */
export function loadRenderer(win: BrowserWindow, role: Role, search = ''): Promise<void> {
  const { devServerUrl } = getOriginConfig();
  const hash = ROLE_HASH[role];
  // Development: the Vite server. Otherwise the built renderer from the app:// scheme (not file://).
  return win.loadURL(`${devServerUrl ?? APP_ENTRY_URL}#${hash}${search}`);
}

/** The BrowserWindow `icon` option for this platform (empty where the exe carries the icon). */
function devWindowIcon(): { icon?: string } {
  return windowIconFor(process.platform, {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
}

export function createMainWindow(options: { show?: boolean } = {}): BrowserWindow {
  const showOnReady = options.show ?? true;
  const win = new BrowserWindow({
    title: 'FrameCapt',
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    ...devWindowIcon(),
    ...titleBarWindowOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: securePreferences(),
  });

  followThemeWithButtons(win);

  registerWebContents(win.webContents, 'main');
  mainWindow = win;
  if (mainProtected) win.setContentProtection(true);
  win.once('ready-to-show', () => {
    if (showOnReady) win.show();
  });
  win.on('close', (event) => {
    if (!quitting && hideOnClose?.()) {
      event.preventDefault();
      win.hide();
      onHiddenToTray?.();
      return;
    }
    if (closeInterceptor?.()) {
      event.preventDefault();
      win.minimize();
      return;
    }
    // Unsaved editor tabs: ask first (a quit asks too; close-to-tray never gets here).
    if (win.webContents.isDestroyed() || closeGuard.onCloseRequested() === 'close') return;
    event.preventDefault();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendEvent(win.webContents, 'editor:confirmClose', {});
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

/** Brings the main window to the front, making it first when there is none (tray, shortcuts, second launch). */
export function showMainWindow(): BrowserWindow {
  const win = getMainWindow() ?? createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/** The window buttons (the title bar overlay) follow the theme; the setting drives nativeTheme.themeSource. */
function followThemeWithButtons(win: BrowserWindow): void {
  if (!hasTitleBarOverlay(process.platform)) return;
  const followTheme = (): void => {
    if (!win.isDestroyed())
      win.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.on('updated', followTheme);
  win.once('closed', () => nativeTheme.off('updated', followTheme));
}

/** The window a dialog belongs to. */
export function dialogParent(): BrowserWindow | undefined {
  return getMainWindow();
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
  const win = createHiddenRecorderWindow('');
  workerWindow = win;
  win.on('closed', () => {
    if (workerWindow === win) workerWindow = undefined;
  });
  return win;
}

/**
 * An extra hidden engine window, for a recording that runs beside the one in the worker window
 * (each recording has its own engine, so each has its own capture grant and streams). It only
 * records: it never serves screenshot frame grabs (`?engine=1`). The caller destroys it.
 */
export function createEngineWindow(): BrowserWindow {
  return createHiddenRecorderWindow('?engine=1');
}

function createHiddenRecorderWindow(search: string): BrowserWindow {
  const win = new BrowserWindow({
    title: 'FrameCapt capture worker',
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    webPreferences: { ...securePreferences(), backgroundThrottling: false },
  });
  registerWebContents(win.webContents, 'recorder');
  void loadRenderer(win, 'recorder', search);
  return win;
}

export function closeWorkerWindow(): void {
  const win = workerWindow;
  workerWindow = undefined;
  if (win && !win.isDestroyed()) win.destroy();
}
