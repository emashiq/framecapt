import { BrowserWindow, screen } from 'electron';
import { TOOLBAR_HEIGHT } from '../../shared/toolbar-placement';
import { log } from '../logger';
import { loadRenderer, registerWebContents, securePreferences } from '../windows';

export interface ToolbarWindow {
  win: BrowserWindow;
  /** Resizes keeping the horizontal center, inside the display's work area. */
  setWidth(width: number): void;
  /** Closes without it counting as the user closing the toolbar. */
  closeQuietly(): void;
}

/**
 * The floating recording toolbar: a small frameless, always-on-top pill. It is excluded from
 * capture with setContentProtection (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+; measured, see
 * docs/capture-feasibility.md) and, for region recordings, placed outside the recorded area so it
 * is not in the picture even if that exclusion failed. It is created hidden and shown by the
 * caller once recording runs. The same pill, in `steps` mode, is the step-guide controls (the
 * renderer picks its content from the `mode` of the URL).
 */
export function createToolbarWindow(
  position: { x: number; y: number },
  width: number,
  onUserClosed: () => void,
  mode: 'recording' | 'steps' = 'recording',
): ToolbarWindow {
  let quiet = false;
  const win = new BrowserWindow({
    title: mode === 'steps' ? 'FrameCapt step controls' : 'FrameCapt recording controls',
    x: position.x,
    y: position.y,
    width,
    height: TOOLBAR_HEIGHT,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { ...securePreferences(), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  // Same quirk as the overlays: place again after creation (mixed-DPI displays).
  win.setBounds({ x: position.x, y: position.y, width, height: TOOLBAR_HEIGHT });
  registerWebContents(win.webContents, 'toolbar');
  win.on('closed', () => {
    if (!quiet) onUserClosed();
  });
  void loadRenderer(win, 'toolbar', mode === 'steps' ? '?mode=steps' : '');

  return {
    win,
    setWidth(next) {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      if (bounds.width === next) return;
      const area = screen.getDisplayMatching(bounds).workArea;
      const centered = bounds.x + Math.round((bounds.width - next) / 2);
      const x = Math.min(Math.max(centered, area.x), area.x + area.width - next);
      win.setBounds({ x, y: bounds.y, width: next, height: TOOLBAR_HEIGHT });
    },
    closeQuietly() {
      quiet = true;
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

export interface CountdownWindow {
  win: BrowserWindow;
  /** Shows it (without taking focus). Called once its renderer asked for the state. */
  reveal(): void;
  close(): void;
}

const COUNTDOWN_SIZE = 220;

/**
 * The 3-2-1 overlay: translucent, centered on the recorded display, click-through, never focused
 * and excluded from capture. It is closed before recording starts, so it can never be in the
 * output either way.
 */
export function createCountdownWindow(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): CountdownWindow {
  const x = Math.round(bounds.x + (bounds.width - COUNTDOWN_SIZE) / 2);
  const y = Math.round(bounds.y + (bounds.height - COUNTDOWN_SIZE) / 2);
  const win = new BrowserWindow({
    title: 'FrameCapt countdown',
    x,
    y,
    width: COUNTDOWN_SIZE,
    height: COUNTDOWN_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { ...securePreferences(), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  win.setBounds({ x, y, width: COUNTDOWN_SIZE, height: COUNTDOWN_SIZE });
  registerWebContents(win.webContents, 'countdown');
  void loadRenderer(win, 'countdown');
  return {
    win,
    reveal() {
      if (!win.isDestroyed()) win.showInactive();
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
      log.info('Countdown window closed');
    },
  };
}
