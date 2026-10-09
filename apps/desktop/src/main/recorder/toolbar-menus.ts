import type { MenuItemConstructorOptions } from 'electron';
import type { DisplayInfo, SourceInfo } from '../capture/types';

/** Longest window title shown in the chooser (titles are never stored). */
const TITLE_MAX = 60;

export interface ScreenshotMenuHandlers {
  recordedArea: () => void;
  region: () => void;
  screen: (displayId: string) => void;
  window: (sourceId: string) => void;
}

function truncate(title: string): string {
  const text = title.trim();
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/**
 * The toolbar's screenshot menu as plain data (so it can be tested): the recorded area, a region,
 * a screen and a window to pick. The ids are stable; labels of screens are generic.
 */
export function buildScreenshotMenuTemplate(
  displays: readonly DisplayInfo[],
  windows: readonly SourceInfo[],
  handlers: ScreenshotMenuHandlers,
): MenuItemConstructorOptions[] {
  const screens: MenuItemConstructorOptions[] = displays.map((display, index) => ({
    id: `screen-${display.id}`,
    label: `Screen ${index + 1} (${display.physicalSize.width}×${display.physicalSize.height})`,
    click: () => handlers.screen(display.id),
  }));
  const windowItems: MenuItemConstructorOptions[] = windows.length
    ? windows.map((source) => ({
        id: `window-${source.id}`,
        label: truncate(source.name) || 'Untitled window',
        click: () => handlers.window(source.id),
      }))
    : [{ id: 'window-none', label: 'No windows found', enabled: false }];
  return [
    { id: 'recorded-area', label: 'Recorded area', click: handlers.recordedArea },
    { id: 'region', label: 'Region…', click: handlers.region },
    { id: 'screen', label: 'Screen', submenu: screens },
    { id: 'window', label: 'Window', submenu: windowItems },
  ];
}
