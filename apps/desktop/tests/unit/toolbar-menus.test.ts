import { describe, expect, it, vi } from 'vitest';
import type { DisplayInfo, SourceInfo } from '../../src/main/capture/types';
import {
  buildPanelMenuTemplate,
  buildScreenshotMenuTemplate,
} from '../../src/main/recorder/toolbar-menus';

const display = (id: string, width: number, height: number): DisplayInfo => ({
  id,
  label: `Display ${id}`,
  bounds: { x: 0, y: 0, width, height },
  scaleFactor: 1,
  rotation: 0,
  physicalSize: { width, height },
  isPrimary: id === '1',
});
const windowSource = (id: string, name: string): SourceInfo => ({ id, name, kind: 'window' });

function handlers() {
  return { recordedArea: vi.fn(), region: vi.fn(), screen: vi.fn(), window: vi.fn() };
}

describe('buildScreenshotMenuTemplate', () => {
  it('lists the recorded area, region, screens and windows', () => {
    const items = buildScreenshotMenuTemplate(
      [display('1', 1920, 1080), display('2', 2560, 1440)],
      [windowSource('window:1:0', 'Notes')],
      handlers(),
    );
    expect(items.map((item) => item.label)).toEqual([
      'Recorded area',
      'Region…',
      'Screen',
      'Window',
    ]);
    const screens = items[2]?.submenu as { label: string }[];
    expect(screens.map((item) => item.label)).toEqual([
      'Screen 1 (1920×1080)',
      'Screen 2 (2560×1440)',
    ]);
  });

  it('routes each item to its handler with the right id', () => {
    const h = handlers();
    const items = buildScreenshotMenuTemplate(
      [display('7', 800, 600)],
      [windowSource('window:5:0', 'Doc')],
      h,
    );
    (items[0]?.click as () => void)();
    (items[1]?.click as () => void)();
    ((items[2]?.submenu as { click: () => void }[])[0] as { click: () => void }).click();
    ((items[3]?.submenu as { click: () => void }[])[0] as { click: () => void }).click();
    expect(h.recordedArea).toHaveBeenCalledOnce();
    expect(h.region).toHaveBeenCalledOnce();
    expect(h.screen).toHaveBeenCalledWith('7');
    expect(h.window).toHaveBeenCalledWith('window:5:0');
  });

  it('truncates long titles to 60 characters and shows a disabled item when there are no windows', () => {
    const long = 'x'.repeat(100);
    const withLong = buildScreenshotMenuTemplate(
      [],
      [windowSource('window:1:0', long)],
      handlers(),
    );
    const label = (withLong[3]?.submenu as { label: string }[])[0]?.label ?? '';
    expect(label).toHaveLength(60);
    expect(label.endsWith('…')).toBe(true);

    const none = buildScreenshotMenuTemplate([], [], handlers());
    expect((none[3]?.submenu as { enabled?: boolean }[])[0]?.enabled).toBe(false);
  });
});

describe('buildPanelMenuTemplate', () => {
  const panelHandlers = () => ({
    region: vi.fn(),
    screen: vi.fn(),
    window: vi.fn(),
    remove: vi.fn(),
  });
  const noPanels = { panels: [], addDisabled: false };

  it('lists region, screens, windows, a separator and the panels to remove', () => {
    const items = buildPanelMenuTemplate(
      [display('1', 1920, 1080), display('2', 2560, 1440)],
      [windowSource('window:1:0', 'Notes')],
      { panels: [{ slot: 1, label: 'Panel 2' }], addDisabled: false },
      panelHandlers(),
    );
    expect(items.map((item) => item.label ?? item.type)).toEqual([
      'Region…',
      'Screen',
      'Window',
      'separator',
      'Remove panel',
    ]);
    expect((items[1]?.submenu as { label: string }[]).map((item) => item.label)).toEqual([
      'Screen 1 (1920×1080)',
      'Screen 2 (2560×1440)',
    ]);
    expect((items[4]?.submenu as { label: string }[]).map((item) => item.label)).toEqual([
      'Panel 2',
    ]);
    expect(items.every((item) => item.enabled !== false)).toBe(true);
  });

  it('routes each item to its handler with the right id or slot', () => {
    const h = panelHandlers();
    const items = buildPanelMenuTemplate(
      [display('7', 800, 600)],
      [windowSource('window:5:0', 'Doc')],
      { panels: [{ slot: 2, label: 'Panel 3' }], addDisabled: false },
      h,
    );
    const first = (item: { submenu?: unknown } | undefined) =>
      (item?.submenu as { click: () => void }[])[0] as { click: () => void };
    (items[0]?.click as () => void)();
    first(items[1]).click();
    first(items[2]).click();
    first(items[4]).click();
    expect(h.region).toHaveBeenCalledOnce();
    expect(h.screen).toHaveBeenCalledWith('7');
    expect(h.window).toHaveBeenCalledWith('window:5:0');
    expect(h.remove).toHaveBeenCalledWith(2);
  });

  it('disables adding at the cap or for multi-source recordings, but not removing', () => {
    const items = buildPanelMenuTemplate(
      [display('1', 800, 600)],
      [windowSource('window:1:0', 'Notes')],
      { panels: [{ slot: 1, label: 'Panel 2' }], addDisabled: true },
      panelHandlers(),
    );
    expect(items.slice(0, 3).map((item) => item.enabled)).toEqual([false, false, false]);
    expect(items[4]?.enabled).toBe(true);
  });

  it('shows disabled placeholders without panels or windows, and shortens long titles', () => {
    const none = buildPanelMenuTemplate([], [], noPanels, panelHandlers());
    expect(none[4]?.enabled).toBe(false);
    expect((none[2]?.submenu as { enabled?: boolean }[])[0]?.enabled).toBe(false);
    const long = buildPanelMenuTemplate(
      [],
      [windowSource('window:1:0', 'y'.repeat(100))],
      noPanels,
      panelHandlers(),
    );
    const label = (long[2]?.submenu as { label: string }[])[0]?.label ?? '';
    expect(label).toHaveLength(60);
    expect(label.endsWith('…')).toBe(true);
  });
});
