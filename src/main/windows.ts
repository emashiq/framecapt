import path from 'node:path';
import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron';
import type { AppOriginConfig } from './app-origin';
import type { Role } from '../shared/types';

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

function loadRenderer(win: BrowserWindow, role: Role): Promise<void> {
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  registerWebContents(win.webContents, 'main');
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });

  void loadRenderer(win, 'main');
  return win;
}
