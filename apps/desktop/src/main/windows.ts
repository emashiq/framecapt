import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, screen, webContents, type WebContents } from 'electron';
import { APP_ENTRY_URL } from './app-asset';
import type { AppOriginConfig } from './app-origin';
import type { EditorState } from '../shared/editor-ipc';
import type { Role } from '../shared/types';
import { CloseGuard } from './close-guard';
import {
  EDITOR_DEFAULT_SIZE,
  EDITOR_MIN_SIZE,
  isReachable,
  parseEditorBounds,
} from './editor-bounds';
import { sendEvent } from './events';
import { hasTitleBarOverlay, titleBarOverlay, titleBarWindowOptions } from './title-bar';
import { windowIconFor } from './window-icon';

/** Window backgrounds matching --color-bg in styles.css, so there is no white flash. */
const BACKGROUND = { light: '#f8fafc', dark: '#0b0f1a' } as const;

/** One renderer entry serves every role; the role is picked by location hash (see main.tsx). */
const ROLE_HASH: Record<Role, string> = {
  main: '/',
  editor: '/editor',
  overlay: '/overlay',
  toolbar: '/toolbar',
  recorder: '/recorder',
  countdown: '/countdown',
  camera: '/camera',
};

const roles = new Map<number, Role>();
let mainWindow: BrowserWindow | undefined;

let editorWindow: BrowserWindow | undefined;
/** Asks before the Editor window closes over unsaved tabs (one per window; see close-guard.ts). */
let editorGuard = new CloseGuard();
const editorClosedListeners: (() => void)[] = [];
/** The main window was asked to close while the Editor window is open: it closes after that one. */
let mainCloseWaitsForEditor = false;

/** Runs when the Editor window is gone (the screenshot sessions it held are deleted then). */
export function onEditorWindowClosed(listener: () => void): void {
  editorClosedListeners.push(listener);
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

/** What the Editor window holds, reported by its renderer (the main window's button shows it). */
let editorState: EditorState = { tabs: 0, dirty: false };
export function setEditorState(state: EditorState): void {
  editorState = state;
  editorGuard.setDirty(state.dirty);
  for (const contents of webContentsWithRoles(['main'])) {
    sendEvent(contents, 'editor:stateChanged', state);
  }
}
export function getEditorState(): EditorState {
  return editorState;
}

/** The answer to the "close with unsaved tabs?" question. Returns whether the window closes now. */
export function resolveEditorClose(discard: boolean): boolean {
  if (!editorGuard.resolve(discard)) {
    // "Keep editing" also withdraws a quit (or a main window close) that was waiting on this answer.
    quitting = false;
    mainCloseWaitsForEditor = false;
    return false;
  }
  getEditorWindow()?.close();
  return true;
}

/**
 * While `interceptor()` is true (a recording is running) closing the main window only minimizes
 * it: the window owns nothing, but closing it would close the recorder window with it.
 */
export function setMainCloseInterceptor(interceptor: () => boolean): void {
  closeInterceptor = interceptor;
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
    // Closing the main window ends the app, so the Editor window goes first: it asks about
    // unsaved tabs, and this window closes once it is gone.
    const editor = getEditorWindow();
    if (editor) {
      event.preventDefault();
      mainCloseWaitsForEditor = true;
      // A quit closes every window itself (the Editor window asks on that attempt); a second
      // attempt from here would count as the "close anyway" of the guard.
      if (!quitting) editor.close();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
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

export function getEditorWindow(): BrowserWindow | undefined {
  return editorWindow && !editorWindow.isDestroyed() ? editorWindow : undefined;
}

const editorBoundsFile = (): string => path.join(app.getPath('userData'), 'editor-window.json');

/** The remembered bounds, only when the window would still be reachable on a connected display. */
function readEditorBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
} | null {
  try {
    const bounds = parseEditorBounds(fs.readFileSync(editorBoundsFile(), 'utf8'));
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    return bounds && isReachable(bounds, areas) ? bounds : null;
  } catch {
    return null;
  }
}

function writeEditorBounds(win: BrowserWindow): void {
  try {
    const { x, y, width, height } = win.getNormalBounds();
    fs.writeFileSync(
      editorBoundsFile(),
      JSON.stringify({ x, y, width, height, maximized: win.isMaximized() }),
    );
  } catch {
    // not remembered: fine
  }
}

/**
 * The Editor window: every screenshot and video being edited is a tab of this one window. It
 * has the app's title bar style (the tab strip is the bar; the OS draws only the window buttons),
 * remembers its size and position, and asks before closing over unsaved tabs.
 */
export function createEditorWindow(): BrowserWindow {
  const remembered = readEditorBounds();
  const win = new BrowserWindow({
    title: 'FrameCapt Editor',
    ...(remembered
      ? { x: remembered.x, y: remembered.y, width: remembered.width, height: remembered.height }
      : EDITOR_DEFAULT_SIZE),
    minWidth: EDITOR_MIN_SIZE.width,
    minHeight: EDITOR_MIN_SIZE.height,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    ...devWindowIcon(),
    ...titleBarWindowOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: securePreferences(),
  });
  followThemeWithButtons(win);
  // No default menu: its Ctrl+W (Close Window) would close the window instead of the tab.
  win.removeMenu();
  registerWebContents(win.webContents, 'editor');
  editorWindow = win;
  editorGuard = new CloseGuard();
  editorState = { tabs: 0, dirty: false };
  win.once('ready-to-show', () => {
    if (remembered?.maximized) win.maximize();
    win.show();
    win.focus();
  });
  win.on('close', (event) => {
    writeEditorBounds(win);
    if (win.webContents.isDestroyed() || editorGuard.onCloseRequested() === 'close') return;
    event.preventDefault();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendEvent(win.webContents, 'editor:confirmClose', {});
  });
  // A logoff or shutdown must never wait for the discard question.
  win.on('session-end', () => editorGuard.allowClose());
  win.on('closed', () => {
    if (editorWindow === win) editorWindow = undefined;
    setEditorState({ tabs: 0, dirty: false });
    for (const listener of editorClosedListeners) listener();
    // A main window close or a quit was waiting for this window: carry on.
    if (mainCloseWaitsForEditor) {
      mainCloseWaitsForEditor = false;
      getMainWindow()?.close();
    }
    // A quit that the question had stopped starts again (it also ends an app that would stay in the tray).
    if (quitting) app.quit();
  });
  void loadRenderer(win, 'editor');
  return win;
}

/** Brings the Editor window to the front; undefined when there is none (it is made on the first open). */
export function showEditorWindow(): BrowserWindow | undefined {
  const win = getEditorWindow();
  if (!win) return undefined;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/** The window a dialog belongs to: the focused app window, else the main window, else the editor. */
export function dialogParent(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && (focused === editorWindow || focused === mainWindow)) return focused;
  return getMainWindow() ?? getEditorWindow();
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
    title: 'FrameCapt capture worker',
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

/** The recorder window if it exists; never creates it. */
export function peekWorkerWindow(): BrowserWindow | undefined {
  return workerWindow && !workerWindow.isDestroyed() ? workerWindow : undefined;
}

export function closeWorkerWindow(): void {
  const win = workerWindow;
  workerWindow = undefined;
  if (win && !win.isDestroyed()) win.destroy();
}
