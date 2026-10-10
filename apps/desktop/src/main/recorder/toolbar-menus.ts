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

export interface PanelMenuHandlers {
  region: () => void;
  screen: (displayId: string) => void;
  window: (sourceId: string) => void;
  remove: (slot: number) => void;
}

export interface PanelMenuState {
  /** The panels the recording has now. */
  panels: readonly { slot: number; label: string }[];
  /** No more can be added (the cap) or the recording takes none (several sources). */
  addDisabled: boolean;
}

/**
 * The "Add panel" menu as plain data: a region, a screen or a window to add to the picture, and the
 * panels to take out again. Adding is disabled at the cap and for multi-source recordings.
 */
export function buildPanelMenuTemplate(
  displays: readonly DisplayInfo[],
  windows: readonly SourceInfo[],
  state: PanelMenuState,
  handlers: PanelMenuHandlers,
): MenuItemConstructorOptions[] {
  const enabled = !state.addDisabled;
  const screens: MenuItemConstructorOptions[] = displays.map((display, index) => ({
    id: `panel-screen-${display.id}`,
    label: `Screen ${index + 1} (${display.physicalSize.width}×${display.physicalSize.height})`,
    click: () => handlers.screen(display.id),
  }));
  const windowItems: MenuItemConstructorOptions[] = windows.length
    ? windows.map((source) => ({
        id: `panel-window-${source.id}`,
        label: truncate(source.name) || 'Untitled window',
        click: () => handlers.window(source.id),
      }))
    : [{ id: 'panel-window-none', label: 'No windows found', enabled: false }];
  const removals: MenuItemConstructorOptions[] = state.panels.length
    ? state.panels.map((panel) => ({
        id: `panel-remove-${panel.slot}`,
        label: panel.label,
        click: () => handlers.remove(panel.slot),
      }))
    : [{ id: 'panel-remove-none', label: 'No panels', enabled: false }];
  return [
    { id: 'panel-region', label: 'Region…', enabled, click: handlers.region },
    { id: 'panel-screen', label: 'Screen', enabled, submenu: screens },
    { id: 'panel-window', label: 'Window', enabled, submenu: windowItems },
    { type: 'separator' },
    {
      id: 'panel-remove',
      label: 'Remove panel',
      enabled: state.panels.length > 0,
      submenu: removals,
    },
  ];
}
