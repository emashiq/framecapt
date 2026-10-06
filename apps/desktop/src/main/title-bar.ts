/**
 * The main window's custom title bar: the app draws its own 36 px bar (menus and command center)
 * and the OS draws only the window buttons over it (Electron's `titleBarOverlay`, Windows
 * and Linux). Pure: windows.ts applies it; no Electron import here.
 */

/** Height of the bar and of the window-button overlay, in CSS px (the renderer's bar matches it). */
export const TITLE_BAR_HEIGHT = 36;

/** `--surface-2` and `--fg` of renderer/styles.css, light and dark. */
const OVERLAY_COLORS = {
  light: { color: '#f1f5f9', symbolColor: '#0f172a' },
  dark: { color: '#0f1424', symbolColor: '#e8ebf4' },
} as const;

export interface TitleBarOverlay {
  color: string;
  symbolColor: string;
  height: number;
}

/** Whether this platform draws the window buttons as an overlay (Electron 44: win32 and linux). */
export function hasTitleBarOverlay(platform: string): boolean {
  return platform === 'win32' || platform === 'linux';
}

export function titleBarOverlay(dark: boolean): TitleBarOverlay {
  return { ...OVERLAY_COLORS[dark ? 'dark' : 'light'], height: TITLE_BAR_HEIGHT };
}

/** The BrowserWindow options that turn the native title bar into the overlay (none elsewhere). */
export function titleBarWindowOptions(
  platform: string,
  dark: boolean,
): { titleBarStyle?: 'hidden'; titleBarOverlay?: TitleBarOverlay } {
  return hasTitleBarOverlay(platform)
    ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(dark) }
    : {};
}
